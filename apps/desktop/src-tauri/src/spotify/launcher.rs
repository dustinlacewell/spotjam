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

// Spotify ships two ways on Windows: the Win32 installer drops it under
// %APPDATA%, the Microsoft Store puts it in an AppX package. Both are the same
// Chromium binary and both honour --remote-debugging-port.
#[cfg(target_os = "windows")]
fn spotify_executable() -> Result<String> {
    let installed = installer_executable();
    if let Some(path) = installed.as_ref().filter(|p| exists(p)) {
        return Ok(path.clone());
    }

    let store = store_executable();
    if let Some(path) = store.as_ref().filter(|p| exists(p)) {
        return Ok(path.clone());
    }

    Err(anyhow!(
        "Spotify.exe not found. Looked for the installer build at {} and the \
         Microsoft Store build at {}.",
        installed.as_deref().unwrap_or("<%APPDATA% not set>"),
        store.as_deref().unwrap_or("<no SpotifyAB.SpotifyMusic package>"),
    ))
}

#[cfg(target_os = "windows")]
fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

#[cfg(target_os = "windows")]
fn installer_executable() -> Option<String> {
    std::env::var("APPDATA")
        .ok()
        .map(|appdata| format!("{appdata}\\Spotify\\Spotify.exe"))
}

/// Asks the AppX registry where the Store package lives. We cannot glob
/// WindowsApps for it: that directory denies enumeration to the user, while the
/// package's own subdirectory is readable and executable once its name is known.
#[cfg(target_os = "windows")]
fn store_executable() -> Option<String> {
    use std::os::windows::process::CommandExt;

    // Release builds have no console of their own, so an unadorned subprocess
    // would flash one up on every launch.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-AppxPackage -Name SpotifyAB.SpotifyMusic).InstallLocation",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    let install_location = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if install_location.is_empty() {
        return None;
    }
    Some(format!("{install_location}\\Spotify.exe"))
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
