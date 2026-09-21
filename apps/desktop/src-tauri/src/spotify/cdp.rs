//! One Chrome DevTools Protocol WebSocket connection.
//!
//! Owns request/response correlation, reports when the socket dies, and
//! forwards the protocol event names the bridge cares about. Knows nothing
//! about Spotify.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, watch, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// How many event names we buffer before a slow subscriber starts missing
/// them.
///
/// Lagging is not free: the subscriber is watching for exactly one method,
/// `Runtime.executionContextsCleared`, and `Runtime.enable` makes the page
/// send every `consoleAPICalled` and `executionContextCreated` down the same
/// channel. A reload emits a burst — contexts cleared, then created, then the
/// console noise of a fresh xpui — so the event that matters sits at the front
/// of the burst most likely to overrun a small buffer. The supervisor now
/// re-checks the page when it does lag, but a buffer with room for a whole
/// reload burst means it rarely has to.
const EVENT_BUFFER: usize = 512;

/// Bound on a whole `Runtime.evaluate` round trip, including the time the
/// page may take to settle an awaited promise. CDP itself never bounds that
/// await, so without this a never-settling promise would hang the caller
/// forever (see the devtool finding on the evaluate hang).
const EVALUATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Waiters for in-flight requests, plus whether the reader has shut down.
///
/// The flag lives inside the map's lock on purpose. The reader clears the
/// waiters exactly once and then exits, so an insert that lands after that
/// would wait on a sender nobody is left to drop. Refusing the insert under
/// the same lock makes that ordering impossible rather than unlikely.
#[derive(Default)]
struct Pending {
    waiters: HashMap<u64, oneshot::Sender<Value>>,
    reader_done: bool,
}

pub struct CdpClient {
    next_id: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    write: Mutex<futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >>,
    closed: watch::Receiver<bool>,
    events: broadcast::Sender<String>,
    /// The reader owns the WebSocket's read half and would otherwise run
    /// forever: it only ends when `read.next()` returns `None`, which needs
    /// the socket closed, which needs both halves dropped — one of which the
    /// reader itself holds. Keeping the handle lets `Drop` end it, which
    /// drops the read half; the last `Arc` dropping the client drops the
    /// write half. Only then is the socket actually closed.
    reader: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for CdpClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Self> {
        let (ws_stream, _) = connect_async(ws_url).await?;
        let (write, mut read) = ws_stream.split();
        let pending: Arc<Mutex<Pending>> = Arc::new(Mutex::new(Pending::default()));
        let (closed_tx, closed_rx) = watch::channel(false);
        let (events, _) = broadcast::channel(EVENT_BUFFER);

        let pending_reader = pending.clone();
        let events_reader = events.clone();
        let reader = tauri::async_runtime::spawn(async move {
            while let Some(msg) = read.next().await {
                let Ok(Message::Text(text)) = msg else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };

                // A message carries either a response id or an event method.
                if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                    let mut pending = pending_reader.lock().await;
                    if let Some(sender) = pending.waiters.remove(&id) {
                        let _ = sender.send(parsed);
                    }
                } else if let Some(method) = parsed.get("method").and_then(|v| v.as_str()) {
                    let _ = events_reader.send(method.to_string());
                }
            }
            // The stream ended or errored. Nothing else marks the client dead,
            // so the reader has to: every waiter hangs otherwise.
            let _ = closed_tx.send(true);
            let mut pending = pending_reader.lock().await;
            pending.reader_done = true;
            pending.waiters.clear();
        });

        let client = Self {
            next_id: AtomicU64::new(1),
            pending,
            write: Mutex::new(write),
            closed: closed_rx,
            events,
            reader,
        };

        // Without this the page sends no Runtime events, so a reload of xpui
        // would pass unnoticed and we would keep evaluating into a dead context.
        client.send(serde_json::json!({
            "id": client.next_id.fetch_add(1, Ordering::SeqCst),
            "method": "Runtime.enable",
        }))
        .await?;

        Ok(client)
    }

    /// True once the socket has ended. A closed client never recovers; the
    /// session replaces it.
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Resolves when the socket ends. Returns at once if it already has.
    pub async fn closed(&self) {
        let mut rx = self.closed.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// A stream of CDP event method names, e.g.
    /// `Runtime.executionContextsCleared`.
    pub fn events(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    /// Evaluate a JS expression in the target page and return its JSON result.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        if self.is_closed() {
            return Err(anyhow!("CDP connection closed"));
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            // The reader has already swept the waiters and exited, so nothing
            // would ever drop this one. Fail now instead of waiting forever.
            if pending.reader_done {
                return Err(anyhow!("CDP connection closed"));
            }
            pending.waiters.insert(id, tx);
        }

        self.send(serde_json::json!({
            "id": id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
            }
        }))
        .await?;

        // CDP does not bound how long an awaited page-side promise may take
        // to settle (the protocol's `timeout` param governs side-effect
        // execution, not the await), so a never-settling promise would leave
        // this future pending forever. Bound the whole round trip here.
        let response = tokio::time::timeout(EVALUATE_TIMEOUT, rx)
            .await
            .map_err(|_| anyhow!("CDP evaluate timed out after {}s", EVALUATE_TIMEOUT.as_secs()))?
            .map_err(|_| anyhow!("CDP connection closed before response"))?;

        if let Some(error) = response.get("error") {
            return Err(anyhow!("CDP protocol error: {error}"));
        }
        let result = response
            .get("result")
            .ok_or_else(|| anyhow!("CDP response missing 'result': {response}"))?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(anyhow!("JS exception: {exception}"));
        }
        result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .ok_or_else(|| anyhow!("CDP result missing value: {result}"))
    }

    async fn send(&self, request: Value) -> Result<()> {
        self.write
            .lock()
            .await
            .send(Message::Text(request.to_string()))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reader marks itself done and sweeps the waiters under one lock. A
    /// request that arrives after that must be refused, not parked: the task
    /// that would have dropped its sender has already exited, so parking it
    /// means waiting forever with no timeout above it.
    #[tokio::test]
    async fn a_request_is_refused_once_the_reader_has_swept_the_waiters() {
        let pending = Arc::new(Mutex::new(Pending::default()));

        // A waiter registered while the socket was alive.
        let (tx, alive_rx) = oneshot::channel::<Value>();
        pending.lock().await.waiters.insert(1, tx);

        // The reader shuts down: flag first, then the sweep, both under the lock.
        {
            let mut guard = pending.lock().await;
            guard.reader_done = true;
            guard.waiters.clear();
        }

        // The in-flight waiter was released rather than left hanging.
        assert!(alive_rx.await.is_err());

        // A later arrival sees the flag and does not park itself.
        let guard = pending.lock().await;
        assert!(guard.reader_done);
        assert!(guard.waiters.is_empty());
    }

    /// The subscriber watches for one method out of everything `Runtime.enable`
    /// sends, and a reload emits that method at the head of a burst. A buffer
    /// that a burst overruns drops exactly the event the supervisor exists to
    /// catch, so it has to hold a whole reload's worth. Checked at compile
    /// time: a shrunk buffer must not build, not merely fail a test run.
    const _BUFFER_HOLDS_A_RELOAD_BURST: () = assert!(EVENT_BUFFER >= 256);

    /// A lagged subscriber must still see later events: the channel is not
    /// closed by an overrun, so the supervisor's re-check has something to
    /// watch afterwards.
    #[tokio::test]
    async fn a_lagged_subscriber_recovers_and_keeps_receiving() {
        let (tx, mut rx) = broadcast::channel::<String>(2);
        for n in 0..5 {
            let _ = tx.send(format!("event{n}"));
        }

        // The overrun is reported once, as a lag.
        assert!(matches!(
            rx.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));

        // And the receiver is still usable, so a re-check is not the only
        // thing standing between us and the next real event.
        let _ = tx.send("Runtime.executionContextsCleared".to_string());
        let seen = loop {
            match rx.recv().await {
                Ok(method) if method == "Runtime.executionContextsCleared" => break true,
                Ok(_) => continue,
                // A lag can repeat: the overrun that dropped the first batch
                // can drop the event we are waiting for too. The receiver is
                // still live, so keep reading rather than giving up — that is
                // exactly what the supervisor must not do.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break false,
            }
        };
        assert!(
            seen,
            "a lagged receiver stays usable; the event after the overrun must arrive"
        );
    }
}
