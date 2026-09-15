mod identity;
mod spotify;

use spotify::SpotifyBridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            spotify::spotify_add_to_playlist,
            spotify::spotify_remove_from_playlist,
            spotify::spotify_move_in_playlist,
            spotify::spotify_fetch_tracks,
            identity::identity_load,
            identity::identity_create,
            identity::identity_sign,
            identity::identity_import,
            identity::identity_export_path,
            identity::identity_username,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
