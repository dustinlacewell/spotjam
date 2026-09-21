//! The Tauri-facing surface of the Spotify bridge.
//!
//! Every command is a thin wrapper: it borrows the live CDP client from the
//! session and hands it to one of the api modules. The session owns when
//! there is a client at all.

mod cdp;
mod launcher;
mod player_api;
mod playlist_api;
mod registry;
mod session;
mod target;
mod track_api;

pub use player_api::{Observation, PlayerState};
pub use playlist_api::{PlaylistContents, PlaylistError, RowRef};
pub use session::BridgeState;
pub use track_api::TrackMetadata;

use cdp::CdpClient;
use session::BridgeSession;
use std::sync::Arc;

/// The app's handle on the Spotify connection.
///
/// A shared handle, not an owner: the session behind it lives in a
/// supervisor task that connects and reconnects on its own.
#[derive(Clone)]
pub struct SpotifyBridge {
    session: Arc<BridgeSession>,
}

impl SpotifyBridge {
    pub fn new() -> Self {
        Self {
            session: Arc::new(BridgeSession::new()),
        }
    }

    /// Starts the supervisor and reports state changes to the front end.
    /// Called once, from the app's setup.
    pub fn start(&self, app: tauri::AppHandle) {
        use tauri::Emitter;

        let mut states = self.session.subscribe();
        // Setup runs outside any Tokio context; Tauri's runtime is the one
        // that exists here.
        tauri::async_runtime::spawn(async move {
            // Emit once up front so a window that opens late is not left
            // guessing until the next transition.
            let _ = app.emit("spotify-bridge", BridgeEvent::of(*states.borrow()));
            while states.changed().await.is_ok() {
                let state = *states.borrow_and_update();
                let _ = app.emit("spotify-bridge", BridgeEvent::of(state));
            }
        });

        self.session.clone().spawn_supervisor();
    }

    async fn with_client<T>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>>,
    ) -> Result<T, String> {
        self.session.with_client(f).await
    }

    async fn with_client_typed<T>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, PlaylistError>> + Send + 'a>,
        >,
    ) -> Result<T, PlaylistError> {
        self.session
            .with_client_typed(f, PlaylistError::unreachable_from, PlaylistError::describe)
            .await
    }
}

impl Default for SpotifyBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// The `spotify-bridge` event payload. An object rather than a bare string,
/// so a later field does not break the listener.
#[derive(serde::Serialize, Clone)]
struct BridgeEvent {
    state: String,
}

impl BridgeEvent {
    fn of(state: BridgeState) -> Self {
        Self {
            state: state.to_string(),
        }
    }
}

/// What the bridge can do right now.
#[tauri::command]
pub async fn spotify_bridge_state(
    bridge: tauri::State<'_, SpotifyBridge>,
) -> Result<BridgeState, String> {
    Ok(bridge.session.state())
}

/// Tries to connect once, now, and reports where that left the bridge.
///
/// For a user who has just started Spotify and does not want to wait out the
/// supervisor's backoff.
#[tauri::command]
pub async fn spotify_connect(
    bridge: tauri::State<'_, SpotifyBridge>,
) -> Result<BridgeState, String> {
    Ok(bridge.session.connect().await)
}

#[tauri::command]
pub async fn spotify_play_track(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::play_track(client, uri)))
        .await
}

#[tauri::command]
pub async fn spotify_pause(bridge: tauri::State<'_, SpotifyBridge>) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::pause(client)))
        .await
}

#[tauri::command]
pub async fn spotify_resume(bridge: tauri::State<'_, SpotifyBridge>) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::resume(client)))
        .await
}

#[tauri::command]
pub async fn spotify_seek(
    bridge: tauri::State<'_, SpotifyBridge>,
    position_ms: u64,
) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::seek(client, position_ms)))
        .await
}

#[tauri::command]
pub async fn spotify_get_state(
    bridge: tauri::State<'_, SpotifyBridge>,
) -> Result<PlayerState, String> {
    bridge
        .with_client(|client| Box::pin(player_api::get_state(client)))
        .await
}

/// Playback state and the head of the user queue, read in one round trip.
///
/// One tick asks once: the two halves then describe the same moment, which
/// separate `spotify_get_state` / `spotify_get_queue` calls cannot promise.
#[tauri::command]
pub async fn spotify_observe(
    bridge: tauri::State<'_, SpotifyBridge>,
) -> Result<Observation, String> {
    bridge
        .with_client(|client| Box::pin(player_api::observe(client)))
        .await
}

/// Makes the local queue hold exactly this track, so Spotify plays it next
/// without a gap. Idempotent: calling it repeatedly with the same URI leaves
/// a single queued entry.
#[tauri::command]
pub async fn spotify_set_next_track(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::set_next_track(client, uri)))
        .await
}

#[tauri::command]
pub async fn spotify_clear_queue(bridge: tauri::State<'_, SpotifyBridge>) -> Result<(), String> {
    bridge
        .with_client(|client| Box::pin(player_api::clear_queue(client)))
        .await
}

#[tauri::command]
pub async fn spotify_get_queue(
    bridge: tauri::State<'_, SpotifyBridge>,
) -> Result<Vec<String>, String> {
    bridge
        .with_client(|client| Box::pin(player_api::get_queue(client)))
        .await
}

/// Returns a playlist's name and every `spotify:track:` entry it holds.
/// Accepts either a `spotify:playlist:ID` URI or an open.spotify.com URL.
///
/// Failures come back typed rather than as a string: the caller has to tell a
/// playlist that no longer exists from a client it could not reach, because
/// only the first may drop a linked playlist.
#[tauri::command]
pub async fn spotify_fetch_playlist(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
) -> Result<PlaylistContents, PlaylistError> {
    bridge
        .with_client_typed(|client| Box::pin(playlist_api::fetch_playlist(client, uri)))
        .await
}

/// Appends tracks to a Spotify playlist through the signed-in client.
///
/// Spotify owns a linked playlist's content, so an add goes there rather than
/// to any local copy; the playlist picks the tracks up on its next sync.
#[tauri::command]
pub async fn spotify_add_to_playlist(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
    track_uris: Vec<String>,
) -> Result<(), PlaylistError> {
    bridge
        .with_client_typed(|client| {
            Box::pin(playlist_api::add_to_playlist(client, uri, track_uris))
        })
        .await
}

/// Removes rows from a Spotify playlist, addressed by their row uids.
#[tauri::command]
pub async fn spotify_remove_from_playlist(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
    rows: Vec<RowRef>,
) -> Result<(), PlaylistError> {
    bridge
        .with_client_typed(|client| Box::pin(playlist_api::remove_from_playlist(client, uri, rows)))
        .await
}

/// Moves a row so it sits before or after another row.
///
/// Exactly one of `before_uid` / `after_uid` is expected: Spotify has no "end"
/// spec for a move, so landing last means naming the row currently there.
#[tauri::command]
pub async fn spotify_move_in_playlist(
    bridge: tauri::State<'_, SpotifyBridge>,
    uri: String,
    rows: Vec<RowRef>,
    before_uid: Option<String>,
    after_uid: Option<String>,
) -> Result<(), PlaylistError> {
    bridge
        .with_client_typed(|client| {
            Box::pin(playlist_api::move_in_playlist(
                client, uri, rows, before_uid, after_uid,
            ))
        })
        .await
}

/// Looks up display metadata for several tracks through the signed-in
/// client. One entry per id, in order; `None` where the id is unknown.
#[tauri::command]
pub async fn spotify_fetch_tracks(
    bridge: tauri::State<'_, SpotifyBridge>,
    track_ids: Vec<String>,
) -> Result<Vec<Option<TrackMetadata>>, String> {
    bridge
        .with_client(|client| Box::pin(track_api::fetch_tracks(client, track_ids)))
        .await
}
