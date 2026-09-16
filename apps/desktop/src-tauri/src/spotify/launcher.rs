//! Finding and starting the Spotify executable.
//!
//! Spawning only. Waiting for the debug port to come up is the session's
//! job, so this returns as soon as the process is handed to the OS.

use anyhow::{anyhow, Result};

const DEBUG_PORT: u16 = 9222;

/// Starts Spotify with remote debugging enabled.
///
/// Spotify is single-instance: if one is already running, this process exits
/// immediately and changes nothing. Only call it when no Spotify is running.
pub fn spawn_spotify() -> Result<()> {
    let spotify_exe = spotify_executable()?;

    let child = std::process::Command::new(&spotify_exe)
        .arg(format!("--remote-debugging-port={DEBUG_PORT}"))
        .spawn()
        .map_err(|e| anyhow!("failed to launch {spotify_exe}: {e}"))?;

    // Dropped on purpose: the thread outlives this call, which is the point.
    let _ = reap(child);
    Ok(())
}

/// Stops a launched Spotify from becoming our problem after it exits.
///
/// Dropping a `Child` does not wait on it. On Unix the process then stays a
/// zombie in our process table until the app exits, and on Windows we keep its
/// handle open. Neither matters once — but the supervisor calls this on every
/// attempt that finds no Spotify and a closed port, which is every retry while
/// Spotify is slow to start or the user has it uninstalled. A long session
/// accumulates one per retry.
///
/// Waiting cannot happen here: Spotify outlives the call by design, and the
/// launcher must return as soon as the process is handed to the OS. So a
/// detached thread does the waiting. One blocked thread per launch is the cost;
/// it ends when that Spotify does.
/// Returns the waiting thread's handle so a test can prove the wait happens.
/// The launcher drops it: nothing in the app has a reason to join.
fn reap(mut child: std::process::Child) -> std::thread::JoinHandle<Option<std::process::ExitStatus>> {
    std::thread::spawn(move || child.wait().ok())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A `Child` that is dropped without a wait is never collected: on Unix
    /// the exited process stays a zombie in our process table until the app
    /// exits. The supervisor spawns once per retry while Spotify is missing,
    /// so an unreaped launch is a leak that grows with the session.
    ///
    /// The fix is a wait, and this is what proves one happens: the reaper
    /// yields the child's exit status. A `reap` that merely dropped the child
    /// would have no status to yield.
    #[test]
    fn a_launched_process_is_waited_on_rather_than_dropped() {
        let status = reap(short_lived_process())
            .join()
            .expect("the reaping thread must not panic");

        assert!(
            status.is_some(),
            "no exit status came back, so nothing waited on the child and the \
             process was left for the OS to hold"
        );
    }

    /// The reaper must not block its caller. The launcher returns as soon as
    /// the process is handed to the OS, because Spotify takes seconds to open
    /// its port and the session does the waiting.
    #[test]
    fn reaping_does_not_block_the_launcher() {
        let child = long_lived_process();
        let pid = child.id();

        let started = std::time::Instant::now();
        let handle = reap(child);
        let elapsed = started.elapsed();

        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "reap blocked for {elapsed:?}; it must hand the wait to a thread"
        );

        kill(pid);
        let _ = handle.join();
    }

    #[cfg(target_os = "windows")]
    fn short_lived_process() -> std::process::Child {
        std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .expect("cmd is present on every Windows host")
    }

    #[cfg(not(target_os = "windows"))]
    fn short_lived_process() -> std::process::Child {
        std::process::Command::new("true")
            .spawn()
            .expect("true is present on every POSIX host")
    }

    // `ping` rather than `timeout`: `timeout` refuses a redirected stdin, and
    // on a host with Git Bash on PATH the name resolves to the POSIX tool,
    // which rejects Windows' `/T` syntax.
    #[cfg(target_os = "windows")]
    fn long_lived_process() -> std::process::Child {
        std::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("cmd is present on every Windows host")
    }

    #[cfg(not(target_os = "windows"))]
    fn long_lived_process() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep is present on every POSIX host")
    }

    #[cfg(target_os = "windows")]
    fn kill(pid: u32) {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    fn kill(pid: u32) {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}
