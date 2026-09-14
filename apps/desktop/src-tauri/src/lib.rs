mod spotify;
mod track_metadata;

use spotify::SpotifyBridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SpotifyBridge::new())
        .invoke_handler(tauri::generate_handler![
            spotify::spotify_play_track,
            spotify::spotify_pause,
            spotify::spotify_resume,
            spotify::spotify_seek,
            spotify::spotify_get_state,
            spotify::spotify_set_next_track,
            spotify::spotify_clear_queue,
            spotify::spotify_get_queue,
            spotify::spotify_fetch_playlist,
            track_metadata::fetch_track_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
