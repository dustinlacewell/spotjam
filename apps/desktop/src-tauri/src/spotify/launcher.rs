use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::time::Duration;

const DEBUG_PORT: u16 = 9222;

#[derive(Deserialize)]
struct TargetInfo {
    #[serde(rename = "type")]
    target_type: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: String,
}

/// Launches Spotify.exe with remote debugging enabled if it isn't already
/// listening, then returns the WebSocket URL of its main page target.
pub async fn ensure_running_and_get_page_ws_url() -> Result<String> {
    if let Ok(url) = find_page_ws_url().await {
        return Ok(url);
    }

    let spotify_exe = spotify_executable()?;

    tokio::process::Command::new(&spotify_exe)
        .arg(format!("--remote-debugging-port={DEBUG_PORT}"))
        .spawn()
        .map_err(|e| anyhow!("failed to launch {spotify_exe}: {e}"))?;

    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(url) = find_page_ws_url().await {
            return Ok(url);
        }
    }

    Err(anyhow!(
        "Spotify launched but debug port {DEBUG_PORT} never became ready"
    ))
}

#[cfg(target_os = "windows")]
fn spotify_executable() -> Result<String> {
    let path = std::env::var("APPDATA")
        .map(|appdata| format!("{appdata}\\Spotify\\Spotify.exe"))
        .map_err(|_| anyhow!("APPDATA not set"))?;
    if !std::path::Path::new(&path).exists() {
        return Err(anyhow!("Spotify.exe not found at {path}"));
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn spotify_executable() -> Result<String> {
    Ok("/Applications/Spotify.app/Contents/MacOS/Spotify".to_string())
}

// Linux installs (distro package, flatpak wrapper, nix profile) all put a
// `spotify` launcher on PATH; that is the only portable handle we have.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn spotify_executable() -> Result<String> {
    Ok("spotify".to_string())
}

async fn find_page_ws_url() -> Result<String> {
    let targets: Vec<TargetInfo> = reqwest::get(format!("http://127.0.0.1:{DEBUG_PORT}/json"))
        .await?
        .json()
        .await?;

    targets
        .into_iter()
        .find(|t| t.target_type == "page")
        .map(|t| t.web_socket_debugger_url)
        .ok_or_else(|| anyhow!("no page target found on debug port {DEBUG_PORT}"))
}
