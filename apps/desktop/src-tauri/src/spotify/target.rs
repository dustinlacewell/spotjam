//! Finding the Spotify client's xpui page on the CDP debug port.
//!
//! Spotify lists several targets: the xpui window, service workers, and
//! whatever else Chromium keeps open. Only the xpui page holds the React
//! tree we evaluate against, so we select by URL rather than by position.

use serde::Deserialize;

const DEBUG_PORT: u16 = 9222;
const XPUI_HOST: &str = "xpui.app.spotify.com";

#[derive(Debug, Clone, Deserialize)]
pub struct TargetInfo {
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub url: String,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    pub web_socket_debugger_url: String,
}

/// What the debug port told us on one look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// Nothing is listening on the port.
    PortClosed,
    /// The port answered, but no xpui page is in the list yet.
    NoXpuiPage,
    /// The xpui page is there; this is its WebSocket URL.
    Xpui(String),
}

/// Picks the xpui page's WebSocket URL out of a target list.
///
/// The first `type == "page"` is not good enough: Spotify opens other pages
/// (the login window, an ad frame) that carry no xpui React tree.
pub fn pick_xpui_target(targets: &[TargetInfo]) -> Option<String> {
    targets
        .iter()
        .find(|t| t.target_type == "page" && url_host(&t.url) == Some(XPUI_HOST))
        .map(|t| t.web_socket_debugger_url.clone())
}

/// Extracts the host from a URL without pulling in a URL parser: everything
/// between `://` and the next `/`, `?` or `#`, minus any port or userinfo.
fn url_host(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .filter(|s| !s.is_empty())?;
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    Some(host_port.split_once(':').map_or(host_port, |(h, _)| h))
}

/// Asks the debug port what it is hosting right now. Never blocks long: a
/// closed port answers immediately and the request carries its own timeout.
pub async fn probe() -> Probe {
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{DEBUG_PORT}/json"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await;

    let Ok(response) = response else {
        return Probe::PortClosed;
    };
    let Ok(targets) = response.json::<Vec<TargetInfo>>().await else {
        return Probe::PortClosed;
    };

    match pick_xpui_target(&targets) {
        Some(ws_url) => Probe::Xpui(ws_url),
        None => Probe::NoXpuiPage,
    }
}

/// Whether a Spotify process exists — including the case where we could not
/// find out.
///
/// The third arm is not pedantry. "Running" and "not running" lead to opposite
/// actions: one tells the user to restart Spotify, the other launches it. A
/// lookup that failed supports neither, and collapsing it into either one
/// strands somebody — guessing "running" refuses to launch a Spotify that is
/// closed, and guessing "not running" tells a user whose Spotify is open that
/// it is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessPresence {
    /// A process lookup succeeded and found Spotify.
    Present,
    /// A process lookup succeeded and found none.
    Absent,
    /// The lookup itself failed, so we know nothing either way.
    Unknown,
}

/// Asks the OS whether Spotify is running.
///
/// This is what separates "Spotify is not running" from "Spotify is running
/// without --remote-debugging-port". The second cannot be fixed by spawning:
/// Spotify is single-instance, so a second process just exits.
#[cfg(target_os = "windows")]
pub fn spotify_process_running() -> ProcessPresence {
    use std::os::windows::process::CommandExt;

    // Release builds own no console; an unadorned subprocess flashes one up.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Spotify.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            if process_listing_names_spotify(&String::from_utf8_lossy(&out.stdout)) {
                ProcessPresence::Present
            } else {
                ProcessPresence::Absent
            }
        }
        // `tasklist` is missing, denied, or failed. We did not learn anything,
        // and saying so is what keeps the session's spawn path open: a guess of
        // "running" routes to `no-debug-port`, which never launches Spotify and
        // leaves the user advised to restart one that may not be open.
        _ => ProcessPresence::Unknown,
    }
}

/// Whether a `tasklist /NH` listing names a running Spotify.
///
/// `tasklist` reports "no match" on stdout rather than by exit code, and does
/// it in the console's own language, so the only dependable signal is whether
/// the image name itself is in the output. A `/FI IMAGENAME eq` listing can
/// contain that name only in a row for a real process.
#[cfg(any(target_os = "windows", test))]
pub fn process_listing_names_spotify(listing: &str) -> bool {
    listing
        .lines()
        .any(|line| line.to_ascii_lowercase().contains("spotify.exe"))
}

#[cfg(target_os = "macos")]
pub fn spotify_process_running() -> ProcessPresence {
    pgrep("Spotify")
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn spotify_process_running() -> ProcessPresence {
    pgrep("spotify")
}

/// `pgrep` exits 0 when it matched, 1 when it matched nothing, and >1 on a
/// real error. Only the first two are answers.
#[cfg(not(target_os = "windows"))]
fn pgrep(name: &str) -> ProcessPresence {
    match std::process::Command::new("pgrep").args(["-x", name]).output() {
        Ok(out) if out.status.success() => ProcessPresence::Present,
        Ok(out) if out.status.code() == Some(1) => ProcessPresence::Absent,
        _ => ProcessPresence::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(target_type: &str, url: &str, ws: &str) -> TargetInfo {
        TargetInfo {
            target_type: target_type.to_string(),
            url: url.to_string(),
            web_socket_debugger_url: ws.to_string(),
        }
    }

    #[test]
    fn picks_the_xpui_page_over_an_earlier_page() {
        let targets = vec![
            target("page", "https://accounts.spotify.com/login", "ws://a"),
            target("page", "https://xpui.app.spotify.com/index.html", "ws://b"),
        ];
        assert_eq!(pick_xpui_target(&targets), Some("ws://b".to_string()));
    }

    #[test]
    fn ignores_a_non_page_xpui_target() {
        let targets = vec![target(
            "service_worker",
            "https://xpui.app.spotify.com/sw.js",
            "ws://a",
        )];
        assert_eq!(pick_xpui_target(&targets), None);
    }

    #[test]
    fn returns_none_when_no_xpui_page_is_listed() {
        let targets = vec![target("page", "https://open.spotify.com/", "ws://a")];
        assert_eq!(pick_xpui_target(&targets), None);
    }

    #[test]
    fn returns_none_for_an_empty_list() {
        assert_eq!(pick_xpui_target(&[]), None);
    }

    #[test]
    fn reads_the_host_out_of_a_url() {
        assert_eq!(url_host("https://xpui.app.spotify.com/x"), Some("xpui.app.spotify.com"));
        assert_eq!(url_host("https://xpui.app.spotify.com:443/x"), Some("xpui.app.spotify.com"));
        assert_eq!(url_host("https://xpui.app.spotify.com"), Some("xpui.app.spotify.com"));
        assert_eq!(url_host("about:blank"), None);
    }

    /// Userinfo and a query or fragment are the two ways a hostile URL could
    /// smuggle the xpui host past a naive match. Neither does: the authority is
    /// cut at the first `/?#` before any `@` is stripped.
    #[test]
    fn a_host_cannot_be_spoofed_through_userinfo_or_a_fragment() {
        assert_eq!(
            url_host("https://user:pw@xpui.app.spotify.com/x"),
            Some("xpui.app.spotify.com")
        );
        assert_eq!(url_host("https://evil.test/#@xpui.app.spotify.com/"), Some("evil.test"));
        assert_eq!(
            url_host("https://evil.test/?x=@xpui.app.spotify.com"),
            Some("evil.test")
        );
        assert_eq!(url_host("https://evilxpui.app.spotify.com/"), Some("evilxpui.app.spotify.com"));
        assert_eq!(url_host(""), None);
        assert_eq!(url_host("https:///"), None);
    }

    /// ADVERSARY. The three presences are not interchangeable, and the one
    /// that used to be missing is the one that strands a user: a lookup we
    /// could not perform is not evidence that Spotify is running, and routing
    /// it to `Present` is what makes the session refuse to launch Spotify at
    /// all. Pinned here as a property of the type, so a later collapse back to
    /// a bool has to delete a test rather than quietly lose the third case.
    #[test]
    fn a_failed_lookup_is_its_own_answer() {
        assert_ne!(ProcessPresence::Unknown, ProcessPresence::Present);
        assert_ne!(ProcessPresence::Unknown, ProcessPresence::Absent);
    }

    /// A real listing row names the process; the "no tasks" notice does not.
    /// Reading the notice as a match would report Spotify running whenever it
    /// is not, and the session would answer `no-debug-port` — telling the user
    /// to restart a Spotify that is not open.
    #[test]
    fn a_process_listing_is_read_by_the_rows_it_contains() {
        assert!(process_listing_names_spotify(
            "Spotify.exe                  12345 Console                    1    369,592 K"
        ));
        assert!(!process_listing_names_spotify(
            "INFO: No tasks are running which match the specified criteria."
        ));
        assert!(!process_listing_names_spotify(""));
    }

    /// `tasklist` answers in the console's language, so the notice cannot be
    /// matched on its text. Any localised notice that does not name the image
    /// reads as "not running", which is the correct reading.
    #[test]
    fn a_localised_no_match_notice_is_not_a_running_spotify() {
        for notice in [
            "INFORMATION: Es werden keine Aufgaben ausgeführt.",
            "情報: 指定された条件に一致するタスクは実行されていません。",
            "INFO: Aucune tâche en cours d'exécution.",
        ] {
            assert!(!process_listing_names_spotify(notice));
        }
    }

    /// Case is not guaranteed across Windows versions, and a miss here reads
    /// as "Spotify is not running" on a machine where it is.
    #[test]
    fn the_image_name_matches_whatever_case_windows_reports() {
        assert!(process_listing_names_spotify("SPOTIFY.EXE   1 Console  1  1 K"));
        assert!(process_listing_names_spotify("spotify.exe   1 Console  1  1 K"));
    }

    #[test]
    fn a_lookalike_host_is_not_xpui() {
        let targets = vec![target("page", "https://xpui.app.spotify.com.evil.test/", "ws://a")];
        assert_eq!(pick_xpui_target(&targets), None);
    }
}
