use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// A connection to one Chrome DevTools Protocol target's WebSocket.
/// Owns the request/response correlation; knows nothing about Spotify.
pub struct CdpClient {
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    write: Mutex<futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Self> {
        let (ws_stream, _) = connect_async(ws_url).await?;
        let (write, mut read) = ws_stream.split();
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let pending_reader = pending.clone();
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                let Ok(Message::Text(text)) = msg else { continue };
                let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) else { continue };
                let mut pending = pending_reader.lock().await;
                if let Some(sender) = pending.remove(&id) {
                    let _ = sender.send(parsed);
                }
            }
        });

        Ok(Self {
            next_id: AtomicU64::new(1),
            pending,
            write: Mutex::new(write),
        })
    }

    /// Evaluate a JS expression in the target page and return its JSON result value.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request = serde_json::json!({
            "id": id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "timeout": 15000,
            }
        });

        self.write
            .lock()
            .await
            .send(Message::Text(request.to_string().into()))
            .await?;

        let response = rx
            .await
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
}
