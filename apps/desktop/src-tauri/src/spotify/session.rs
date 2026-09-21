//! The bridge's connection lifecycle.
//!
//! One background supervisor owns connecting, reconnecting, and noticing a
//! dead or reloaded page. Commands never wait on it: they read the current
//! state and fail fast when it is not `Ready`. That is what keeps one broken
//! socket from stalling every other command for fifteen seconds.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{watch, Mutex, RwLock};

use super::cdp::CdpClient;
use super::launcher;
use super::registry;
use super::target::{self, Probe, ProcessPresence};

/// How often we re-ask a question whose answer we expect to change on its own.
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How long we keep asking before calling it a failure.
const POLL_LIMIT: Duration = Duration::from_secs(30);
/// How long a caller who found a connect already running waits on it before
/// reporting whatever state that attempt has reached.
///
/// Short enough that the Sync button always answers, long enough that a
/// connect which is nearly done gives the real answer instead of `booting`.
const JOIN_LIMIT: Duration = Duration::from_secs(3);

/// What the bridge can do right now. The UI renders one message per state, so
/// each one has to name a distinct situation the user can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeState {
    /// No Spotify process. We have asked one to start.
    NoSpotify,
    /// Spotify is running, but it was started without the debug port. Only
    /// the user can fix this, by restarting Spotify.
    NoDebugPort,
    /// Spotify is coming up, or its page is reloading. Wait.
    Booting,
    /// Connected, React mounted, commands work.
    Ready,
    /// We were connected and the connection died. Reconnecting.
    Lost,
}

impl std::fmt::Display for BridgeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::NoSpotify => "no-spotify",
            Self::NoDebugPort => "no-debug-port",
            Self::Booting => "booting",
            Self::Ready => "ready",
            Self::Lost => "lost",
        };
        f.write_str(name)
    }
}

/// What one probe means, before we try to act on it.
///
/// Pure so the policy can be read and tested without a Spotify or a port.
/// `Xpui` maps to `Booting`: a reachable page is not yet a mounted one.
/// `NoDebugPort` is reserved for a Spotify we positively found. It is the one
/// state that refuses to launch anything, so guessing it on a process lookup
/// that failed would strand a user whose Spotify is simply closed.
pub fn state_after_probe(probe: &Probe, presence: ProcessPresence) -> BridgeState {
    match probe {
        Probe::PortClosed if presence == ProcessPresence::Present => BridgeState::NoDebugPort,
        Probe::PortClosed => BridgeState::NoSpotify,
        Probe::NoXpuiPage => BridgeState::Booting,
        Probe::Xpui(_) => BridgeState::Booting,
    }
}

/// Whether to launch Spotify ourselves.
///
/// Only a Spotify we positively found is a reason not to: it is single-instance,
/// so a second process would exit and change nothing. A lookup that failed is
/// not that proof, and refusing on it is what removes the user's only way out.
pub fn should_spawn_spotify(probe: &Probe, presence: ProcessPresence) -> bool {
    *probe == Probe::PortClosed && presence != ProcessPresence::Present
}

/// Whether a command's failure means our connection has stopped meaning
/// anything, as opposed to one call going wrong.
///
/// Pure so the policy is testable without a page to break.
///
/// `is_closed` is not the only way the bridge dies. An in-place xpui reload
/// keeps the socket open and throws `window` away, so every injected script
/// then fails on the registry walk. The supervisor normally catches that
/// through `Runtime.executionContextsCleared`, but that is one broadcast
/// event in a bounded buffer: a lagged receiver drops it and the bridge sits
/// `Ready` forever while every command fails. These messages are the page
/// telling us the same thing the event would have, so they demote too.
///
/// Only failures of the walk itself count. A service that rejected a request,
/// a playlist that is gone, a timeout — those are one call going wrong on a
/// connection that still works, and demoting on them would flap the gate.
///
/// The text this reads is not ours alone, which is why neither marker is a
/// bare English phrase. `normalise_playlist_uri` echoes the caller's own paste
/// back in its error, and a thrown page error carries whatever a playlist or
/// track is named — Spotify lets a user name one anything, and the name reaches
/// us inside `JS exception: {exceptionDetails}` verbatim (confirmed against the
/// signed-in client). Matching "no React fiber found" anywhere in a message
/// therefore let a paste, or a playlist named after the error, drop the gate
/// over a perfectly healthy bridge.
///
/// So each marker is anchored to something only the real failure can produce:
/// the walk stamps its own throws with `registry::STALE_PREFIX`, and the lost
/// execution context is reported by CDP itself, in the protocol envelope that
/// page script cannot write into.
pub fn failure_means_connection_is_stale(message: &str) -> bool {
    // The registry walk threw: `resolveService` found no fiber, or no registry
    // context above it. Either way this `window` is not the one we reached
    // ready on. The prefix is stamped by the walk, so a name or a paste that
    // merely quotes the words does not match.
    if message.contains(registry::STALE_PREFIX) {
        return true;
    }

    // The socket answered, but the context we evaluate into is gone. This one
    // comes from CDP, not from our script, so it cannot carry the stamp — it
    // is anchored to the protocol-error frame instead. A page that throws an
    // error merely naming the phrase lands in `JS exception:` and does not
    // match here.
    message.starts_with("CDP protocol error:")
        && message.contains("Cannot find context with specified id")
}

/// Whether a remount actually restored a serviceable page.
///
/// Pure so the policy is testable without a page to reload. Both halves are
/// required: a page that mounted on top of stashes we failed to drop is still
/// serving whatever those stashes name, and reporting it ready is the wedge
/// the drop was added to prevent.
pub fn remount_succeeded(stashes_dropped: bool, mounted: bool) -> bool {
    stashes_dropped && mounted
}

/// How long to wait before retry number `attempt` (0-based).
///
/// Doubles to ten seconds and stays there. A user who starts Spotify should
/// not wait a minute for us to notice, so the backoff has a ceiling.
pub fn backoff(attempt: u32) -> Duration {
    let seconds = match attempt {
        0 => 1,
        1 => 2,
        2 => 4,
        3 => 8,
        _ => 10,
    };
    Duration::from_secs(seconds)
}

/// What one `connect` call did, for a caller that has to tell an attempt from
/// a wait on someone else's.
struct ConnectOutcome {
    state: BridgeState,
    /// False when the guard was already taken, so this call ran no attempt.
    was_ours: bool,
}

pub struct BridgeSession {
    state: watch::Sender<BridgeState>,
    client: RwLock<Option<Arc<CdpClient>>>,
    /// Held for the duration of a connect attempt. A second caller does not
    /// queue behind it; it reports the state the first attempt is producing.
    connecting: Mutex<()>,
}

impl BridgeSession {
    pub fn new() -> Self {
        let (state, _) = watch::channel(BridgeState::Booting);
        Self {
            state,
            client: RwLock::new(None),
            connecting: Mutex::new(()),
        }
    }

    pub fn state(&self) -> BridgeState {
        *self.state.borrow()
    }

    /// Fires on every state change, for the task that forwards to the UI.
    pub fn subscribe(&self) -> watch::Receiver<BridgeState> {
        self.state.subscribe()
    }

    fn set_state(&self, next: BridgeState) {
        if self.state() != next {
            // `send` throws the value away when no receiver is alive, which
            // would make the whole state machine a no-op whenever nothing is
            // listening. The stored state is the source of truth for every
            // command, so it must move whether or not anyone hears it.
            self.state.send_replace(next);
        }
    }

    /// Runs one connection attempt and returns where it left the bridge.
    ///
    /// Concurrent callers do not stack: whoever finds the guard taken waits a
    /// moment on the attempt already running rather than starting a second one
    /// against the same port.
    pub async fn connect(&self) -> BridgeState {
        self.connect_attempt().await.state
    }

    /// `connect`, plus whether this call ran the attempt or only watched one.
    ///
    /// The supervisor needs the difference and the command does not. A caller
    /// that found the guard taken made no attempt, so counting its result as a
    /// failure would climb the backoff for someone else's work — and the guard
    /// can be held for `POLL_LIMIT`, so that is thirty seconds of phantom
    /// failures ending at the ceiling.
    async fn connect_attempt(&self) -> ConnectOutcome {
        let Ok(_guard) = self.connecting.try_lock() else {
            return ConnectOutcome {
                state: self.join_attempt_in_flight().await,
                was_ours: false,
            };
        };

        let state = self.attempt_connect().await;
        self.set_state(state);
        ConnectOutcome {
            state,
            was_ours: true,
        }
    }

    /// Waits briefly on the connect already in progress, then reports the
    /// state it has reached.
    ///
    /// The supervisor's attempt can poll for up to `POLL_LIMIT`, and the user
    /// pressing Sync lands in the middle of that far more often than not.
    /// Returning `self.state()` at once answers `booting` to a button whose
    /// whole point is "tell me if it worked", so the user presses it again and
    /// gets the same non-answer. Waiting the whole attempt out is no better:
    /// it would hang the button for half a minute.
    ///
    /// So wait a short while for the state to move, and report whatever it has
    /// become. A connect that finishes inside the window gives the real
    /// answer; one that does not still returns promptly, and the state event
    /// arrives on its own when the attempt lands.
    async fn join_attempt_in_flight(&self) -> BridgeState {
        let mut states = self.subscribe();
        let deadline = tokio::time::Instant::now() + JOIN_LIMIT;

        loop {
            let state = *states.borrow_and_update();
            if state == BridgeState::Ready {
                return state;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self.state();
            }
            // A closed channel cannot happen — we hold a sender — but a
            // timeout can, and both mean "report what we have".
            if tokio::time::timeout(remaining, states.changed())
                .await
                .is_err()
            {
                return self.state();
            }
        }
    }

    async fn attempt_connect(&self) -> BridgeState {
        let ws_url = match self.reach_xpui_page().await {
            Ok(url) => url,
            Err(state) => {
                // The client we held belonged to the Spotify we just failed to
                // reach. Leaving it in place lets `watch_ready` pick up a dead
                // socket on a later pass and sit on it — the supervisor would
                // then be watching a connection that can never produce an
                // event, and only the socket's own close would break it out.
                self.drop_client().await;
                return state;
            }
        };

        let client = match CdpClient::connect(&ws_url).await {
            Ok(client) => Arc::new(client),
            // The page was listed a moment ago and now will not talk. That is
            // a connection that died under us, not a Spotify that is missing.
            Err(_) => {
                self.drop_client().await;
                return BridgeState::Lost;
            }
        };

        self.set_state(BridgeState::Booting);
        *self.client.write().await = Some(client.clone());

        if wait_until_mounted(&client).await {
            BridgeState::Ready
        } else {
            BridgeState::Booting
        }
    }

    /// Gets as far as an xpui page URL, starting Spotify if none is running.
    /// The error side is the state that explains why we got no further.
    async fn reach_xpui_page(&self) -> Result<String, BridgeState> {
        let probe = target::probe().await;
        if let Probe::Xpui(url) = probe {
            return Ok(url);
        }

        let presence = target::spotify_process_running();
        let state = state_after_probe(&probe, presence);

        if state == BridgeState::NoDebugPort {
            // Spawning cannot help: Spotify is single-instance, so a second
            // process would exit and leave the same portless client running.
            return Err(BridgeState::NoDebugPort);
        }

        if should_spawn_spotify(&probe, presence) && launcher::spawn_spotify().is_err() {
            return Err(BridgeState::NoSpotify);
        }

        self.set_state(state);

        match poll_for_xpui().await {
            Some(url) => Ok(url),
            None => Err(state),
        }
    }

    /// Borrows the live client for one call.
    ///
    /// Never connects and never waits: if the bridge is not `Ready` the call
    /// fails now with the state that says why. The supervisor owns the
    /// client's life, so a failed call does not drop it — except when the
    /// failure is the connection itself, which the supervisor must hear about.
    pub async fn with_client<T>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>>,
    ) -> Result<T, String> {
        let client = self.ready_client().await?;

        match f(&client).await {
            Ok(value) => Ok(value),
            Err(e) => {
                let message = e.to_string();
                self.demote_if_meaningless(&client, &message);
                Err(message)
            }
        }
    }

    /// `with_client` for a call that reports its own typed failure.
    ///
    /// A playlist fetch must tell "this playlist is gone" from "we could not
    /// ask", because only the first may drop a linked playlist. Failing to
    /// reach the client is always the second.
    pub async fn with_client_typed<T, E>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send + 'a>>,
        unreachable: impl Fn(String) -> E,
        describe: impl Fn(&E) -> String,
    ) -> Result<T, E> {
        let client = match self.ready_client().await {
            Ok(client) => client,
            Err(message) => return Err(unreachable(message)),
        };

        let result = f(&client).await;
        if let Err(error) = &result {
            self.demote_if_meaningless(&client, &describe(error));
        }
        result
    }

    /// Lets go of the client we hold, so nothing can be handed a socket that
    /// belongs to a Spotify we can no longer reach. Dropping the last `Arc`
    /// also ends its reader task, which is what keeps a long session of
    /// reconnects from accumulating one per attempt.
    async fn drop_client(&self) {
        self.client.write().await.take();
    }

    /// Brings a page that lost its execution context back to serviceable.
    ///
    /// Drops the stashes first. A cleared context usually takes `window` with
    /// it, which is what makes `ensure_script`'s early return safe — but a
    /// same-document navigation clears the context and keeps `window`, leaving
    /// stashes that name services the page has abandoned. `ensure_script`
    /// would then never re-resolve them and every command would fail against a
    /// bridge reporting `ready`. Deleting keys that are already gone costs one
    /// evaluation and makes the survivor case impossible.
    /// The drop is not best-effort. `executionContextsCleared` arrives while
    /// the page is between contexts, so an evaluation issued right then has
    /// nothing to land in and fails — and a failed drop that we ignored would
    /// let the mount poll hand back `Ready` over stashes we never cleared,
    /// which is the whole case this exists to stop. So wait for the page to be
    /// serviceable first, then drop, then confirm it mounted with the stashes
    /// actually gone.
    async fn remount(&self, client: &CdpClient) -> bool {
        if !wait_until_mounted(client).await {
            return false;
        }
        let dropped = matches!(
            client.evaluate(&registry::DROP_STASHES_JS).await,
            Ok(value) if value.as_bool() == Some(true)
        );
        remount_succeeded(dropped, wait_until_mounted(client).await)
    }

    /// Marks the bridge lost when a command's failure says the connection is
    /// no longer worth anything — a dead socket, or a page that has thrown
    /// away the `window` we resolved services on.
    fn demote_if_meaningless(&self, client: &CdpClient, message: &str) {
        self.demote_on(client.is_closed(), message);
    }

    /// The decision above, separated from the client so it can be driven
    /// without a socket.
    fn demote_on(&self, socket_closed: bool, message: &str) {
        if socket_closed || failure_means_connection_is_stale(message) {
            self.set_state(BridgeState::Lost);
        }
    }

    async fn ready_client(&self) -> Result<Arc<CdpClient>, String> {
        let state = self.state();
        if state != BridgeState::Ready {
            return Err(format!("spotify bridge: {state}"));
        }

        // Cloned out so no lock is held across the call itself; one slow
        // command must not block every other one.
        let client = self.client.read().await.clone();

        match client {
            Some(client) if !client.is_closed() => Ok(client),
            Some(_) => {
                self.set_state(BridgeState::Lost);
                Err(format!("spotify bridge: {}", BridgeState::Lost))
            }
            None => Err(format!("spotify bridge: {}", BridgeState::Booting)),
        }
    }

    /// Starts the one task that owns the connection for the app's lifetime.
    pub fn spawn_supervisor(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            let mut attempt = 0u32;
            loop {
                let outcome = self.connect_attempt().await;
                if outcome.state == BridgeState::Ready {
                    attempt = 0;
                    self.watch_ready().await;
                    continue;
                }
                tokio::time::sleep(backoff(attempt)).await;
                // Only an attempt we ran ourselves says anything about how
                // hard this is. A call that merely watched a Sync press does
                // not, and counting it would have us at the ten-second ceiling
                // by the time we first get to try.
                if outcome.was_ours {
                    attempt = attempt.saturating_add(1);
                }
            }
        });
    }

    /// Sits on a ready connection until something ends it.
    ///
    /// Three things can: the socket dies, xpui reloads, or the state watcher
    /// reports the bridge has been demoted to `Lost` underneath us. The last
    /// is the easy one to miss: a command's `demote_on` runs on another task
    /// and never touches the socket or the event stream, and an in-place xpui
    /// reload keeps the WebSocket open — `executionContextsCleared` has
    /// already been delivered (that is how the command failed in the first
    /// place), so no further event and no close ever arrive. Without this
    /// arm the supervisor would sit here forever reporting `lost` while no
    /// reconnect ever ran.
    async fn watch_ready(&self) {
        let Some(client) = self.client.read().await.clone() else {
            self.set_state(BridgeState::Lost);
            return;
        };

        let mut events = client.events();
        let mut states = self.subscribe();

        loop {
            tokio::select! {
                // A command demoted the bridge to `Lost` out from under this
                // watch — most plausibly a stale-page failure, which means
                // this client belongs to a context we no longer reach. The
                // socket stays open, so neither of the other arms can fire;
                // without this arm the supervisor never reconnects.
                _ = state_turns_lost(&mut states) => {
                    self.set_state(BridgeState::Lost);
                    return;
                }
                _ = client.closed() => {
                    self.set_state(BridgeState::Lost);
                    return;
                }
                event = events.recv() => {
                    match event {
                        Ok(method) if method == "Runtime.executionContextsCleared" => {
                            self.set_state(BridgeState::Booting);
                            if self.remount(&client).await {
                                self.set_state(BridgeState::Ready);
                            } else {
                                self.set_state(BridgeState::Lost);
                                return;
                            }
                        }
                        // Nothing we act on.
                        Ok(_) => {}
                        // The buffer overran, so we do not know what we
                        // missed — and the one event that matters is exactly
                        // the one a burst drops. Treating a lag as "nothing
                        // happened" leaves the bridge `Ready` on a page that
                        // may have reloaded. Re-ask the page instead: it is
                        // one cheap evaluation, and it answers the only
                        // question the dropped event would have.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if !wait_until_mounted_once(&client).await {
                                self.set_state(BridgeState::Booting);
                                if self.remount(&client).await {
                                    self.set_state(BridgeState::Ready);
                                } else {
                                    self.set_state(BridgeState::Lost);
                                    return;
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            self.set_state(BridgeState::Lost);
                            return;
                        }
                    }
                }
            }
        }
    }
}

impl Default for BridgeSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Waits until the observed bridge state becomes `Lost`.
///
/// The supervisor's `watch_ready` parks on this: a command demoting the
/// bridge on another task never closes the socket and never produces a CDP
/// event, so the state watch is the only channel that carries the news. A
/// change that is not `Lost` (e.g. `Booting` while a remount runs) just
/// clears the watch's update flag and keeps waiting. A closed channel —
/// impossible while the session lives — also releases, so the caller can
/// never hang on a dead watch.
async fn state_turns_lost(states: &mut watch::Receiver<BridgeState>) {
    loop {
        if *states.borrow_and_update() == BridgeState::Lost {
            return;
        }
        if states.changed().await.is_err() {
            return;
        }
    }
}

/// Re-probes until the xpui page appears, or the limit runs out.
async fn poll_for_xpui() -> Option<String> {
    poll(|| async {
        match target::probe().await {
            Probe::Xpui(url) => Some(url),
            _ => None,
        }
    })
    .await
}

/// Asks the page once whether it can still serve a command. No polling: this
/// is the cheap re-check after we lost track of the event stream, and a `false`
/// here is a question for the caller, not a verdict.
async fn wait_until_mounted_once(client: &CdpClient) -> bool {
    if client.is_closed() {
        return false;
    }
    matches!(
        client.evaluate(&registry::REACT_MOUNTED_JS).await,
        Ok(value) if value.as_bool() == Some(true)
    )
}

/// Asks the page whether React has mounted, until it says yes.
async fn wait_until_mounted(client: &CdpClient) -> bool {
    poll(|| async {
        if client.is_closed() {
            // Stop early: no amount of waiting revives a dead socket.
            return Some(false);
        }
        match client.evaluate(&registry::REACT_MOUNTED_JS).await {
            Ok(value) if value.as_bool() == Some(true) => Some(true),
            _ => None,
        }
    })
    .await
    .unwrap_or(false)
}

/// Runs `check` every `POLL_INTERVAL` until it answers, giving up at
/// `POLL_LIMIT`.
async fn poll<T, F, Fut>(check: F) -> Option<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + POLL_LIMIT;
    loop {
        if let Some(value) = check().await {
            return Some(value);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADVERSARY. `spotify_process_running` answers `true` when it could not
    /// ask — `tasklist` missing from PATH, denied, or timing out. The comment
    /// defending that calls `no-debug-port` "the safe wrong answer", on the
    /// grounds that it tells the user to restart Spotify, which is also the fix
    /// for the real case.
    ///
    /// It is not safe, because `no-debug-port` is not only a message. It is
    /// also the one state `reach_xpui_page` refuses to spawn from: it returns
    /// before the spawn, on the reasoning that a second Spotify would exit
    /// anyway. So on a host where the process lookup is broken and Spotify is
    /// genuinely closed, the bridge answers `no-debug-port` forever, tells the
    /// user to restart a Spotify that is not running, and never launches one
    /// itself. The user cannot get out of it from inside the app.
    ///
    /// The lookup therefore has to admit it does not know, and "unknown" must
    /// not be routed to the one state that disables the escape hatch.
    #[test]
    fn a_process_lookup_that_failed_does_not_strand_the_user_at_no_debug_port() {
        // A lookup that worked and found nothing: Spotify is closed, we spawn.
        assert_eq!(
            state_after_probe(&Probe::PortClosed, ProcessPresence::Absent),
            BridgeState::NoSpotify
        );
        // A lookup that worked and found one: only a restart helps.
        assert_eq!(
            state_after_probe(&Probe::PortClosed, ProcessPresence::Present),
            BridgeState::NoDebugPort
        );
        // A lookup we could not perform. Guessing `no-debug-port` here is what
        // strands the user, because that state never spawns.
        assert_eq!(
            state_after_probe(&Probe::PortClosed, ProcessPresence::Unknown),
            BridgeState::NoSpotify,
            "an unknown process state must leave the spawn path open, not \
             advise a restart of something that may not be running"
        );
    }

    /// And the spawn decision itself, stated once and pinned. `NoDebugPort` is
    /// the only presence that must not spawn — it is the case where a second
    /// process provably cannot help.
    #[test]
    fn spawning_is_refused_only_when_spotify_is_known_to_be_running() {
        assert!(should_spawn_spotify(
            &Probe::PortClosed,
            ProcessPresence::Absent
        ));
        assert!(should_spawn_spotify(
            &Probe::PortClosed,
            ProcessPresence::Unknown
        ));
        assert!(!should_spawn_spotify(
            &Probe::PortClosed,
            ProcessPresence::Present
        ));
        // An open port is never a reason to spawn, whatever the lookup said.
        for presence in [
            ProcessPresence::Absent,
            ProcessPresence::Unknown,
            ProcessPresence::Present,
        ] {
            assert!(!should_spawn_spotify(&Probe::NoXpuiPage, presence));
        }
    }

    #[test]
    fn a_closed_port_with_spotify_running_means_no_debug_port() {
        assert_eq!(
            state_after_probe(&Probe::PortClosed, ProcessPresence::Present),
            BridgeState::NoDebugPort
        );
    }

    #[test]
    fn a_closed_port_with_no_spotify_means_no_spotify() {
        assert_eq!(
            state_after_probe(&Probe::PortClosed, ProcessPresence::Absent),
            BridgeState::NoSpotify
        );
    }

    #[test]
    fn an_open_port_without_an_xpui_page_is_booting() {
        assert_eq!(
            state_after_probe(&Probe::NoXpuiPage, ProcessPresence::Present),
            BridgeState::Booting
        );
    }

    #[test]
    fn a_reachable_xpui_page_is_still_only_booting() {
        assert_eq!(
            state_after_probe(&Probe::Xpui("ws://x".into()), ProcessPresence::Present),
            BridgeState::Booting
        );
    }

    /// REFUTED, and pinned. The ready probe swallows every failure, so it
    /// cannot tell "not mounted yet" from "mounted but permanently broken" —
    /// both answer `false`. That conflation would wedge the bridge only if a
    /// `false` could hold it somewhere forever, and it cannot: the mount poll
    /// is bounded by `POLL_LIMIT`, a timed-out poll yields `Booting` rather
    /// than `Ready`, and the supervisor treats any non-`Ready` as a failed
    /// attempt and runs a whole fresh connect — new probe, new socket — after
    /// a backoff that is capped at ten seconds.
    ///
    /// So a page that answers `false` forever produces reconnects forever, not
    /// a wedge. This pins the property the argument rests on: the retry wait is
    /// bounded, so the supervisor always comes back round.
    #[test]
    fn a_probe_that_never_says_yes_still_gets_retried_forever() {
        // Whatever the attempt count, the next try is at most the ceiling away.
        for attempt in [0u32, 1, 5, 100, u32::MAX] {
            assert!(
                backoff(attempt) <= Duration::from_secs(10),
                "attempt {attempt} waits longer than the ceiling, so a page that \
                 answers false could stall the supervisor"
            );
        }
        // And the mount poll itself gives up rather than blocking the loop.
        assert!(
            POLL_LIMIT >= POLL_INTERVAL,
            "the poll must run at least once before its deadline"
        );
        assert!(
            POLL_LIMIT <= Duration::from_secs(60),
            "an unbounded mount poll would park the supervisor instead of \
             letting it reconnect"
        );
    }

    #[test]
    fn backoff_doubles_then_holds_at_ten_seconds() {
        let seconds: Vec<u64> = (0..7).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(seconds, vec![1, 2, 4, 8, 10, 10, 10]);
    }

    /// INTENDED. A session that ran for hours and then dropped must retry at
    /// once, not at the ten-second ceiling the earlier failures climbed to.
    /// The supervisor gets that by resetting the counter when a connect
    /// succeeds, so this pins the reset rather than the arithmetic: the first
    /// wait after any success is the shortest one.
    #[test]
    fn a_reconnect_after_a_good_session_waits_the_shortest_backoff() {
        let mut attempt = 0u32;

        // Several failures climb to the ceiling.
        for _ in 0..6 {
            let _ = backoff(attempt);
            attempt = attempt.saturating_add(1);
        }
        assert_eq!(backoff(attempt).as_secs(), 10);

        // A connect succeeds; the supervisor resets the counter here.
        attempt = 0;

        assert_eq!(
            backoff(attempt),
            backoff(0),
            "a drop after a good session must retry at once"
        );
    }

    /// INTENDED. The counter saturates rather than wrapping, so a bridge left
    /// failing overnight keeps waiting the ceiling instead of wrapping round
    /// to a one-second hot retry.
    #[test]
    fn the_attempt_counter_saturates_at_the_ceiling() {
        assert_eq!(backoff(u32::MAX).as_secs(), 10);
        assert_eq!(u32::MAX.saturating_add(1), u32::MAX);
    }

    #[test]
    fn states_display_as_their_serialized_names() {
        assert_eq!(BridgeState::NoSpotify.to_string(), "no-spotify");
        assert_eq!(BridgeState::NoDebugPort.to_string(), "no-debug-port");
        assert_eq!(BridgeState::Booting.to_string(), "booting");
        assert_eq!(BridgeState::Ready.to_string(), "ready");
        assert_eq!(BridgeState::Lost.to_string(), "lost");
    }

    #[test]
    fn display_matches_serde() {
        for state in [
            BridgeState::NoSpotify,
            BridgeState::NoDebugPort,
            BridgeState::Booting,
            BridgeState::Ready,
            BridgeState::Lost,
        ] {
            let json = serde_json::to_string(&state).unwrap();
            assert_eq!(json, format!("\"{state}\""));
        }
    }

    /// `watch::Sender::send` discards the value when no receiver is alive. The
    /// stored state is what every command reads, so it has to move regardless.
    #[test]
    fn state_moves_even_when_nothing_is_subscribed() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::NoDebugPort);
        assert_eq!(session.state(), BridgeState::NoDebugPort);
    }

    /// The same, after a subscriber has come and gone.
    #[test]
    fn state_moves_after_the_last_subscriber_drops() {
        let session = BridgeSession::new();
        drop(session.subscribe());
        session.set_state(BridgeState::Lost);
        assert_eq!(session.state(), BridgeState::Lost);
    }

    #[tokio::test]
    async fn a_command_on_a_bridge_that_is_not_ready_fails_with_the_state() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::NoDebugPort);
        match session.ready_client().await {
            Ok(_) => panic!("a bridge that is not ready must not hand out a client"),
            Err(message) => assert_eq!(message, "spotify bridge: no-debug-port"),
        }
    }

    /// An in-place xpui reload keeps the socket open. If the supervisor misses
    /// `Runtime.executionContextsCleared` — one event in a bounded broadcast
    /// buffer, explicitly ignored when the receiver lags — nothing else
    /// demotes the bridge, so it reports `ready` while every command throws on
    /// the registry walk. The page's own error text has to demote it.
    #[test]
    fn a_page_that_lost_its_react_tree_makes_the_connection_meaningless() {
        let stamp = registry::STALE_PREFIX;
        assert!(failure_means_connection_is_stale(&format!(
            "JS exception: Error: {stamp} no React fiber found"
        )));
        assert!(failure_means_connection_is_stale(&format!(
            "JS exception: Error: {stamp} no RegistryContext found in fiber tree"
        )));
        assert!(failure_means_connection_is_stale(
            "CDP protocol error: Cannot find context with specified id"
        ));
    }

    /// The stamp has to survive the trip the real failure takes. The walk
    /// throws it, the page serializes the throw into `exceptionDetails`, and
    /// `cdp::evaluate` formats that whole blob into the message the classifier
    /// reads. This is the live client's exact serialization, captured off the
    /// signed-in client over CDP.
    #[test]
    fn the_stamp_survives_the_real_exception_serialization() {
        let stamp = registry::STALE_PREFIX;
        let as_cdp_reports_it = format!(
            r#"JS exception: {{"exceptionId":1,"text":"Uncaught","lineNumber":0,"columnNumber":9,"scriptId":"62","exception":{{"type":"object","subtype":"error","className":"Error","description":"Error: {stamp} no React fiber found\n    at <anonymous>:1:16"}}}}"#
        );
        assert!(
            failure_means_connection_is_stale(&as_cdp_reports_it),
            "the walk's stamp must still be readable after CDP serializes the throw"
        );
    }

    /// Every throw the walk itself performs must carry the stamp, or a real
    /// stale page goes unnoticed and the bridge wedges at `ready` — the exact
    /// wedge the classifier exists to break. Read off the script rather than
    /// asserted by hand, so a later edit to the walk cannot drift from this.
    #[test]
    fn every_walk_failure_the_script_throws_is_stamped() {
        let resolve: &str = &registry::RESOLVE_SERVICE_JS;
        let stamped = resolve.matches(registry::STALE_PREFIX).count();
        assert_eq!(
            stamped, 2,
            "the walk throws two failures that mean the page is stale — no fiber \
             and no registry context — and both must be stamped"
        );
        for phrase in ["no React fiber found", "no RegistryContext found in fiber tree"] {
            let stamped_phrase = format!("{} {phrase}", registry::STALE_PREFIX);
            assert!(
                resolve.contains(&stamped_phrase),
                "{phrase:?} must be thrown stamped, or a stale page reads as healthy"
            );
        }
    }

    /// `registry.resolve(name) returned falsy` is deliberately NOT stamped. A
    /// registry that answers at all is a live page; it is telling us that one
    /// service is missing, not that the walk failed. Demoting there would drop
    /// the gate whenever Spotify renames a service.
    #[test]
    fn a_service_missing_from_a_live_registry_is_not_a_stale_page() {
        let resolve: &str = &registry::RESOLVE_SERVICE_JS;
        assert!(
            resolve.contains(r#"throw new Error("registry.resolve(" + name + ") returned falsy")"#),
            "the falsy-service throw must stay unstamped"
        );
        assert!(!failure_means_connection_is_stale(
            "JS exception: Error: registry.resolve(PlayerAPI) returned falsy"
        ));
    }

    /// The classifier has to be wired into the command path, not merely exist:
    /// a bridge left `Ready` after a reload fails every command forever,
    /// because `watch_ready` is parked in its select and the supervisor never
    /// re-runs `connect`.
    #[test]
    fn a_stale_page_error_moves_the_bridge_out_of_ready() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        session.demote_on(
            false,
            &format!(
                "JS exception: Error: {} no React fiber found",
                registry::STALE_PREFIX
            ),
        );
        assert_eq!(session.state(), BridgeState::Lost);
    }

    /// And the same path must leave a working bridge alone.
    #[test]
    fn an_ordinary_command_error_leaves_the_bridge_ready() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        session.demote_on(false, "Invalid playlist or members response!");
        assert_eq!(session.state(), BridgeState::Ready);
    }

    /// ADVERSARY. The wedge this pins is subtler than the state change above:
    /// `demote_on` runs on a command task while the supervisor is parked in
    /// `watch_ready`'s select, which used to wake only on `client.closed()`
    /// or a CDP event. An in-place xpui reload keeps the WebSocket open and
    /// has already delivered `executionContextsCleared` — that is how the
    /// command failed via the classifier in the first place — so no further
    /// event and no close ever arrive. The bridge then reports `lost` with
    /// every command failing and `connect_attempt` never running again: a
    /// permanent outage until the app restarts.
    ///
    /// The fix is the `state_turns_lost` arm. The demotion carries its news
    /// only on the state watch, so the watch has to be one of the things
    /// `watch_ready` waits on. This exercises the primitive end-to-end over
    /// the session's own watch: `demote_on` from outside must release it.
    #[tokio::test(start_paused = true)]
    async fn a_demotion_releases_the_ready_watch() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        let mut states = session.subscribe();

        let watched = tokio::spawn(async move {
            state_turns_lost(&mut states).await;
        });

        // The exact call a failing command makes: socket still open, message
        // stamped as stale. Only the state watch learns about it.
        session.demote_on(
            false,
            &format!(
                "JS exception: Error: {} no React fiber found",
                registry::STALE_PREFIX
            ),
        );

        assert!(
            tokio::time::timeout(Duration::from_secs(1), watched).await.is_ok(),
            "a demotion to Lost must wake the supervisor's ready watch, or the \
             bridge wedges until the app restarts"
        );
    }

    /// The watch arm must not fire spuriously: a remount sets `Booting` from
    /// inside `watch_ready`'s own event arm, which wakes this same watch. A
    /// change to anything but `Lost` must keep the supervisor parked, or
    /// every reload would tear down a remount mid-recovery.
    #[tokio::test(start_paused = true)]
    async fn a_change_to_something_other_than_lost_keeps_the_ready_watch_parked() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        let mut states = session.subscribe();

        let watched = tokio::spawn(async move {
            state_turns_lost(&mut states).await;
        });

        // A remount's intermediate state. Not a reason to reconnect.
        session.set_state(BridgeState::Booting);
        tokio::time::advance(Duration::from_secs(1)).await;

        assert!(
            !watched.is_finished(),
            "a non-Lost state change must not end the ready watch"
        );

        // And the Lost change it was installed for still works after.
        session.set_state(BridgeState::Lost);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), watched).await.is_ok(),
            "the watch must still fire on the state it exists for"
        );
    }

    /// ADVERSARY. The classifier reads a message that is not always the page's
    /// own words. `normalise_playlist_uri` puts the caller's raw text into its
    /// error — "not a Spotify playlist URI or URL: {trimmed}" — and
    /// `with_client_typed` feeds exactly that string to the classifier. So a
    /// user who pastes text carrying a marker demotes a bridge that is working
    /// perfectly, and the room's gate drops over a healthy connection.
    ///
    /// Nothing about the paste reaches the page at all: the URI is rejected
    /// before any evaluation, so the connection was never even exercised.
    #[test]
    fn a_marker_inside_a_users_own_input_does_not_demote_the_bridge() {
        let pasted = "no React fiber found";
        let rejection = format!("not a Spotify playlist URI or URL: {pasted}");

        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        session.demote_on(false, &rejection);
        assert_eq!(
            session.state(),
            BridgeState::Ready,
            "a bad paste must not take the bridge down: the page never ran"
        );
    }

    /// ADVERSARY. The same hole from the other side. A track or playlist whose
    /// *name* carries a marker round-trips through the page's own catch —
    /// `String(e?.message ?? e)` — and through `JS exception: {exception}`,
    /// whose serialized `exceptionDetails` carries the thrown string verbatim.
    /// Spotify lets a user name a playlist anything.
    #[test]
    fn a_marker_inside_page_data_does_not_demote_the_bridge() {
        for message in [
            // A playlist the user named after the error text. This is the
            // live client's own serialization of such a throw, captured over
            // CDP: the name reaches us verbatim inside `description`.
            r#"JS exception: {"text":"Uncaught","exception":{"description":"Error: Playlist \"no React fiber found\" is empty\n    at <anonymous>:1:16"}}"#,
            // The page reported its own failure as data, quoting an item name.
            r#"Cannot read properties of undefined (reading 'no React fiber found')"#,
            // A track named after the CDP marker, thrown by the page. It is a
            // JS exception, not a protocol error, so it must not match.
            r#"JS exception: {"exception":{"description":"Error: Cannot find context with specified id"}}"#,
        ] {
            let session = BridgeSession::new();
            session.set_state(BridgeState::Ready);
            session.demote_on(false, message);
            assert_eq!(
                session.state(),
                BridgeState::Ready,
                "{message:?} names the marker as data, not as the walk failing"
            );
        }
    }

    /// A dead socket still demotes, whatever the message says.
    #[test]
    fn a_closed_socket_demotes_regardless_of_the_message() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        session.demote_on(true, "anything at all");
        assert_eq!(session.state(), BridgeState::Lost);
    }

    /// One call going wrong is not a dead connection. Demoting on these would
    /// drop the gate over the room every time a playlist 404s or a request
    /// times out, and the supervisor would tear down a working socket.
    #[test]
    fn a_failed_call_on_a_working_page_does_not_demote_the_bridge() {
        for message in [
            "Invalid playlist or members response!",
            "timed out waiting for Spotify to return the playlist",
            "registry.resolve(PlayerAPI) returned falsy",
            "getQueue did not return a JSON string: null",
            "add failed",
        ] {
            assert!(
                !failure_means_connection_is_stale(message),
                "{message:?} is one call failing, not a dead connection"
            );
        }
    }

    /// A second caller does not start a second attempt against the same port.
    /// It waits out `JOIN_LIMIT` on the one already running and then reports
    /// the state that attempt has reached.
    #[tokio::test(start_paused = true)]
    async fn a_second_connect_reports_the_state_instead_of_attempting() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::NoSpotify);
        let held = session.connecting.lock().await;
        assert_eq!(session.connect().await, BridgeState::NoSpotify);
        drop(held);
    }

    /// INTENDED. Two commands must be able to run at once. The metadata batch
    /// lookup and a playlist import are issued independently, and a playlist
    /// fetch can take twelve seconds — if borrowing the client held a lock for
    /// the length of the call, that fetch would freeze every other command.
    ///
    /// `ready_client` clones the `Arc` out and drops the read guard before
    /// returning, so this proves the borrow itself is not a mutual exclusion:
    /// a second borrow succeeds while the first is still held.
    #[tokio::test]
    async fn borrowing_the_client_does_not_serialise_commands() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);

        // Two borrows in flight at once. Neither holds the session's lock, so
        // a writer can still take it — which is what a reconnect needs to do.
        let first = session.client.read().await.clone();
        let second = session.client.read().await.clone();
        assert!(first.is_none() && second.is_none());

        // And the write side is not blocked by a borrow that is still alive.
        drop(first);
        drop(second);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), session.client.write())
                .await
                .is_ok(),
            "a reconnect must be able to replace the client while commands run"
        );
    }

    /// ADVERSARY. `remount` threw its drop result away — `let _ = ...` — and
    /// then reported whatever the mount poll said. The two are not independent.
    ///
    /// `Runtime.executionContextsCleared` arrives while the page is between
    /// contexts, so the drop lands in the window where an evaluation has
    /// nothing to land in and fails. The mount poll then waits, React comes
    /// back, and `remount` answers `true` — with the stashes never dropped.
    /// That is exactly the survivor case the drop exists to prevent: on a
    /// same-document navigation `window` persists, so those stashes still name
    /// services the page abandoned, and the bridge goes `Ready` over them.
    ///
    /// So a drop that did not happen cannot be ignored. This pins the decision
    /// without a page: a remount is only good if the drop was confirmed.
    #[test]
    fn a_remount_whose_drop_failed_is_not_a_good_remount() {
        // dropped, mounted -> good
        assert!(remount_succeeded(true, true));
        // The failure that matters: the page came back but we never cleared
        // the stashes, so what came back may still be serving dead services.
        assert!(
            !remount_succeeded(false, true),
            "a mount on top of stashes we failed to drop is not a remount"
        );
        assert!(!remount_succeeded(true, false));
        assert!(!remount_succeeded(false, false));
    }

    /// REFUTED, and pinned. `drop_client` on a failed reconnect cannot pull a
    /// socket out from under a command that is mid-evaluate: `ready_client`
    /// hands out an `Arc` clone, so the client outlives the session's slot and
    /// dies only when the last holder lets go. The drop is a refcount
    /// decrement, not a teardown, so an in-flight call finishes against a live
    /// socket and returns its real result rather than a spurious error.
    #[tokio::test]
    async fn dropping_the_client_does_not_disturb_a_command_already_holding_it() {
        let session = BridgeSession::new();

        // Stand in for a connected client with a plain Arc: what matters here
        // is the ownership, which is the same shape.
        let borrowed = Arc::new(());
        *session.client.write().await = None;

        // A command took its clone before the reconnect failed.
        let held_by_command = borrowed.clone();
        assert_eq!(Arc::strong_count(&borrowed), 2);

        // The session lets go of its own reference.
        session.drop_client().await;
        drop(borrowed);

        // The command's clone is still alive and still the only owner, so its
        // evaluate is unaffected.
        assert_eq!(Arc::strong_count(&held_by_command), 1);
    }

    /// A failed reconnect must not leave the previous client in place.
    /// `watch_ready` reads `self.client` directly, so a stale one lets the
    /// supervisor settle onto a socket belonging to a Spotify that is gone;
    /// it would then wait for events that can never arrive.
    #[tokio::test]
    async fn a_bridge_with_no_client_hands_out_nothing_even_while_ready() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Ready);
        session.drop_client().await;

        assert!(session.client.read().await.is_none());
        match session.ready_client().await {
            Ok(_) => panic!("a bridge holding no client must not hand one out"),
            Err(message) => assert_eq!(message, "spotify bridge: booting"),
        }
    }

    /// The Sync button exists to answer "did it work". A connect in flight can
    /// poll for thirty seconds, so answering `self.state()` the instant the
    /// guard is taken hands the user `booting` and nothing else — press again,
    /// same non-answer. Joining the attempt returns the real result as soon as
    /// it lands.
    #[tokio::test(start_paused = true)]
    async fn a_second_connect_returns_ready_as_soon_as_the_first_attempt_lands() {
        let session = Arc::new(BridgeSession::new());
        session.set_state(BridgeState::Booting);
        let held = session.connecting.lock().await;

        let lander = session.clone();
        let landing = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            lander.set_state(BridgeState::Ready);
        });

        assert_eq!(session.connect().await, BridgeState::Ready);
        landing.await.unwrap();
        drop(held);
    }

    /// ADVERSARY. `connect` now has two outcomes that look alike to the caller
    /// and are not: it either ran an attempt, or it merely watched someone
    /// else's. The supervisor cannot tell them apart, so it counts a join as a
    /// failed attempt and climbs its backoff for it.
    ///
    /// That matters because the guard can be held for `POLL_LIMIT` — a Sync
    /// press lands in `attempt_connect`, which polls up to thirty seconds. The
    /// supervisor spends that window joining and sleeping, and comes out the
    /// far side at the ten-second ceiling having made no attempt of its own. A
    /// user whose Spotify appears right after their Sync press then waits the
    /// ceiling for the retry that finds it, rather than a second.
    ///
    /// The fix reports whether the attempt was ours, so the supervisor only
    /// counts the ones it actually ran.
    #[tokio::test(start_paused = true)]
    async fn a_supervisor_that_only_joined_does_not_count_a_failed_attempt() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Booting);

        // Someone else's attempt is in flight for longer than the join window.
        let held = session.connecting.lock().await;

        let outcome = session.connect_attempt().await;
        assert!(
            !outcome.was_ours,
            "the guard was taken, so this call watched rather than attempted"
        );

        drop(held);

        // And an attempt we do run is reported as ours.
        let outcome = session.connect_attempt().await;
        assert!(
            outcome.was_ours,
            "with the guard free this call ran the attempt itself"
        );
    }

    /// And it must not hang on an attempt that never lands: the button returns
    /// within the join window whatever the supervisor is doing.
    #[tokio::test(start_paused = true)]
    async fn a_second_connect_gives_up_on_an_attempt_that_never_lands() {
        let session = BridgeSession::new();
        session.set_state(BridgeState::Booting);
        let held = session.connecting.lock().await;

        let started = tokio::time::Instant::now();
        assert_eq!(session.connect().await, BridgeState::Booting);
        let waited = started.elapsed();

        assert!(
            waited >= JOIN_LIMIT && waited < POLL_LIMIT,
            "the button waited {waited:?}: it must join the attempt briefly, \
             not return at once and not wait out a full poll"
        );
        drop(held);
    }
}
