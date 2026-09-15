mod cdp;
mod launcher;
mod player_api;
mod playlist_api;
mod registry;
mod track_api;

pub use player_api::PlayerState;
pub use playlist_api::{PlaylistContents, PlaylistError};
pub use track_api::TrackMetadata;

use cdp::CdpClient;
use tokio::sync::Mutex;

/// Owns the lazily-established CDP connection to the local Spotify client.
/// One bridge per app instance; reconnects on demand if the connection drops.
pub struct SpotifyBridge {
    client: Mutex<Option<CdpClient>>,
}

impl SpotifyBridge {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }

    async fn with_client<T>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>>,
    ) -> Result<T, String> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            let ws_url = launcher::ensure_running_and_get_page_ws_url()
                .await
                .map_err(|e| e.to_string())?;
            let client = CdpClient::connect(&ws_url).await.map_err(|e| e.to_string())?;
            *guard = Some(client);
        }

        let client = guard.as_ref().unwrap();
        match f(client).await {
            Ok(value) => Ok(value),
            Err(e) => {
                // Connection may have gone stale (Spotify restarted); drop it
                // so the next call reconnects.
                *guard = None;
                Err(e.to_string())
            }
        }
    }

    /// Like `with_client`, for a call that reports its own typed failure.
    ///
    /// `with_client` flattens every error to a string, which is exactly what a
    /// playlist fetch must not do: "this playlist is gone" and "Spotify is not
    /// answering" drive opposite actions. Getting to the client can itself
    /// fail, and that is always unreachable — no answer means no verdict about
    /// the playlist.
    ///
    /// The stale connection is dropped only on an unreachable failure. A
    /// `Gone` answer means the client talked to us, so the connection is fine.
    async fn with_client_typed<T>(
        &self,
        f: impl for<'a> FnOnce(
            &'a CdpClient,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, PlaylistError>> + Send + 'a>,
        >,
    ) -> Result<T, PlaylistError> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            let ws_url = launcher::ensure_running_and_get_page_ws_url()
                .await
                .map_err(PlaylistError::unreachable_from)?;
            let client = CdpClient::connect(&ws_url)
                .await
                .map_err(PlaylistError::unreachable_from)?;
            *guard = Some(client);
        }

        let client = guard.as_ref().unwrap();
        let result = f(client).await;
        if matches!(result, Err(PlaylistError::Unreachable { .. })) {
            *guard = None;
        }
        result
    }
}

impl Default for SpotifyBridge {
    fn default() -> Self {
        Self::new()
    }
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
