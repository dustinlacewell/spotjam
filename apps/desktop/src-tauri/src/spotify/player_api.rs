use super::cdp::CdpClient;
use super::registry::ensure_script;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

/// Stashes the internal `PlayerAPI` service on `window.__playerApi` for
/// reuse across calls. Idempotent: safe to evaluate repeatedly, e.g. after
/// a page reload invalidates the stash.
static ENSURE_PLAYER_API_JS: LazyLock<String> =
    LazyLock::new(|| ensure_script("__playerApi", r#"resolveService("PlayerAPI")"#));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub track_uri: Option<String>,
    pub track_name: Option<String>,
    pub is_paused: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
}

async fn ensure_player_api(cdp: &CdpClient) -> Result<()> {
    cdp.evaluate(&ENSURE_PLAYER_API_JS).await?;
    Ok(())
}

/// Starts playback of the given Spotify track URI (e.g. "spotify:track:...").
pub async fn play_track(cdp: &CdpClient, uri: String) -> Result<()> {
    ensure_player_api(cdp).await?;
    let uri_json = serde_json::to_string(&uri)?;
    let expr = format!(
        "(async () => {{ await window.__playerApi.play({{uri: {uri_json}}}, {{}}); return true; }})()"
    );
    cdp.evaluate(&expr).await?;
    Ok(())
}

pub async fn pause(cdp: &CdpClient) -> Result<()> {
    ensure_player_api(cdp).await?;
    cdp.evaluate("(async () => { await window.__playerApi.pause(); return true; })()")
        .await?;
    Ok(())
}

pub async fn resume(cdp: &CdpClient) -> Result<()> {
    ensure_player_api(cdp).await?;
    cdp.evaluate("(async () => { await window.__playerApi.resume(); return true; })()")
        .await?;
    Ok(())
}

/// Seeks the current track to an absolute position in milliseconds.
pub async fn seek(cdp: &CdpClient, position_ms: u64) -> Result<()> {
    ensure_player_api(cdp).await?;
    let expr = format!(
        "(async () => {{ await window.__playerApi.seekTo({position_ms}); return true; }})()"
    );
    cdp.evaluate(&expr).await?;
    Ok(())
}

/// One async JS expression that reads `getState()` and evaluates to the plain
/// object the Rust side parses. Shared verbatim by `get_state` and `observe`
/// so the two can never drift into reporting different positions.
///
/// It is an expression, not a statement block: both callers embed it inside a
/// larger async arrow and `await` it.
const STATE_EXPR_JS: &str = r#"(async () => {
                const s = await window.__playerApi.getState();
                const isPaused = s?.isPaused ?? true;
                const base = s?.positionAsOfTimestamp ?? 0;
                const raw = isPaused
                    ? base
                    : base + (Date.now() - (s?.timestamp ?? Date.now()));
                return {
                    trackUri: s?.item?.uri ?? null,
                    trackName: s?.item?.name ?? null,
                    isPaused,
                    positionMs: Math.max(0, Math.round(raw)),
                    durationMs: Math.max(0, Math.round(s?.duration ?? 0)),
                };
            })()"#;

fn get_state_js() -> String {
    format!("(async () => JSON.stringify(await {STATE_EXPR_JS}))()")
}

pub async fn get_state(cdp: &CdpClient) -> Result<PlayerState> {
    ensure_player_api(cdp).await?;
    let value: Value = cdp.evaluate(&get_state_js()).await?;

    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("getState did not return a JSON string: {value}"))?;
    let parsed: Value = serde_json::from_str(json_str)?;

    Ok(player_state_from_json(&parsed))
}

fn player_state_from_json(parsed: &Value) -> PlayerState {
    PlayerState {
        track_uri: parsed["trackUri"].as_str().map(String::from),
        track_name: parsed["trackName"].as_str().map(String::from),
        is_paused: parsed["isPaused"].as_bool().unwrap_or(true),
        position_ms: non_negative_u64(&parsed["positionMs"]),
        duration_ms: non_negative_u64(&parsed["durationMs"]),
    }
}

/// Everything one sync tick needs from the client, read together.
///
/// Playback state and the head of the user queue come back from a single
/// evaluation, so the two cannot describe different moments.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub state: PlayerState,
    /// The first user-queued URI, or `None` when the queue is empty.
    pub queue_head: Option<String>,
}

/// Builds the one expression that reads state and queue head together.
fn observe_js() -> String {
    format!(
        r#"(async () => {{
            const state = await {STATE_EXPR_JS};
            const q = await window.__playerApi.getQueue();
            const head = (q?.queued ?? [])
                .map((item) => item?.uri)
                .find((uri) => typeof uri === "string") ?? null;
            return JSON.stringify({{ state, queueHead: head }});
        }})()"#
    )
}

/// Reads playback state and the queue head in one round trip.
pub async fn observe(cdp: &CdpClient) -> Result<Observation> {
    ensure_player_api(cdp).await?;
    let value: Value = cdp.evaluate(&observe_js()).await?;

    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("observe did not return a JSON string: {value}"))?;
    let parsed: Value = serde_json::from_str(json_str)?;

    Ok(Observation {
        state: player_state_from_json(&parsed["state"]),
        queue_head: parsed["queueHead"].as_str().map(String::from),
    })
}

/// Replaces the user queue with exactly the given track, so Spotify's own
/// player transitions into it gaplessly when the current track ends.
///
/// Clear-then-add in a single evaluation: `addToQueue` always appends a fresh
/// entry (each gets a new uid), so it is not idempotent on its own. Clearing
/// first makes repeated calls with the same URI converge on a one-item queue.
///
/// Only user-queued items (`provider: "queue"`) are affected; the context's
/// own autoplay list is left intact and still follows once the queue drains.
pub async fn set_next_track(cdp: &CdpClient, uri: String) -> Result<()> {
    ensure_player_api(cdp).await?;
    let uri_json = serde_json::to_string(&uri)?;
    cdp.evaluate(&set_next_track_js(&uri_json)).await?;
    Ok(())
}

/// Removes every user-queued item. Context autoplay is unaffected.
pub async fn clear_queue(cdp: &CdpClient) -> Result<()> {
    ensure_player_api(cdp).await?;
    cdp.evaluate("(async () => { await window.__playerApi.clearQueue(); return true; })()")
        .await?;
    Ok(())
}

/// Returns the URIs of the user-queued tracks, in play order.
///
/// `getQueue()` is not a request. Read off the live client: `PlayerAPI` has
/// `getQueue(){return this._queue.getQueue()}` and the inner one is
/// `getQueue(){return this._queueState}` — a plain field, synchronous, with no
/// round trip to ask. Two reads in a row hand back the identical object
/// (verified: `a === b`).
///
/// That field is written only by the client's own queue subscription, and the
/// callback debounces: when the incoming state has no current context track or
/// an empty `nextTracks`, it defers the update by 500 ms rather than applying
/// it at once. So a read taken just after a write sees the value from before
/// the write, and the gap is up to half a second.
///
/// The caller that matters is the sync driver, which reads the queue each tick
/// to decide whether to re-issue `set_next_track`. Its 2 s poll clears the
/// debounce easily. Its room-change hook does not throttle, so two ticks can
/// land inside one debounce window; the second reads a queue that does not yet
/// show the first's write and re-issues it. That re-issue is a clear-then-add
/// of the same URI, which converges on the same one-item queue — so it costs a
/// redundant write, not a corrupted queue.
///
/// Awaiting `set_next_track` does not close the window: its promise settles on
/// the write reaching the client, not on the cache catching up.
pub async fn get_queue(cdp: &CdpClient) -> Result<Vec<String>> {
    ensure_player_api(cdp).await?;
    let value: Value = cdp
        .evaluate(
            r#"(async () => {
                const q = await window.__playerApi.getQueue();
                const uris = (q?.queued ?? [])
                    .map((item) => item?.uri)
                    .filter((uri) => typeof uri === "string");
                return JSON.stringify(uris);
            })()"#,
        )
        .await?;

    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("getQueue did not return a JSON string: {value}"))?;
    Ok(serde_json::from_str(json_str)?)
}

/// Reads a JSON number as milliseconds, clamping anything negative,
/// fractional, or non-numeric to a sane u64.
pub(super) fn non_negative_u64(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| f.max(0.0) as u64))
        .unwrap_or(0)
}

/// Builds the `set_next_track` expression. Split out so the shape that makes a
/// repeated call harmless can be asserted without a page.
fn set_next_track_js(uri_json: &str) -> String {
    format!(
        r#"(async () => {{
            const api = window.__playerApi;
            await api.clearQueue();
            await api.addToQueue([{{ uri: {uri_json} }}]);
            return true;
        }})()"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `getQueue()` reads a cached field whose refresh debounces by up to
    /// 500 ms (read off the live client), and the sync driver's room-change
    /// hook can tick twice inside that window. The second tick then sees its
    /// own write missing and issues `set_next_track` again.
    ///
    /// That is safe only because the call clears before it adds. `addToQueue`
    /// mints a fresh uid every time, so an add alone would stack duplicates
    /// and the user's queue would grow by one on every redundant tick.
    /// Clear-then-add converges on the same one-item queue instead.
    #[test]
    fn setting_the_next_track_clears_before_it_adds() {
        let js = set_next_track_js(r#""spotify:track:abc""#);
        let clear = js.find("clearQueue").expect("the call must clear the queue");
        let add = js.find("addToQueue").expect("the call must add the track");
        assert!(
            clear < add,
            "clearQueue must run before addToQueue, or a repeated call stacks \
             duplicate queue entries"
        );
        assert!(
            js.contains("await api.clearQueue()"),
            "the clear must be awaited, or the add can race it"
        );
    }

    /// The URI reaches the page as JSON, so a title with a quote in it cannot
    /// break out of the expression.
    #[test]
    fn the_track_uri_is_escaped_into_the_expression() {
        let uri_json = serde_json::to_string(r#"spotify:track:a"); alert(1); ("#).unwrap();
        let js = set_next_track_js(&uri_json);
        assert!(js.contains(r#"\"); alert(1); (""#));
        assert!(!js.contains(r#"a"); alert(1); ("#));
    }

    /// One tick, one evaluation. If either read moved out of this expression
    /// the two halves could describe different moments.
    #[test]
    fn observing_reads_the_state_and_the_queue_in_one_expression() {
        let js = observe_js();
        assert!(js.contains("getState"), "observe must read playback state");
        assert!(js.contains("getQueue"), "observe must read the queue");
        assert!(js.contains("queueHead"), "observe must report the queue head");
    }

    /// `get_state` and `observe` must read position from the same snippet, or
    /// they can report different positions for the same instant.
    #[test]
    fn both_reads_share_the_state_snippet() {
        assert!(get_state_js().contains(STATE_EXPR_JS));
        assert!(observe_js().contains(STATE_EXPR_JS));
    }

    #[test]
    fn parses_an_observation_payload() {
        let parsed = serde_json::json!({
            "state": {
                "trackUri": "spotify:track:abc",
                "trackName": "One",
                "isPaused": false,
                "positionMs": 1500,
                "durationMs": 214000,
            },
            "queueHead": "spotify:track:def",
        });
        let state = player_state_from_json(&parsed["state"]);
        assert_eq!(state.track_uri.as_deref(), Some("spotify:track:abc"));
        assert!(!state.is_paused);
        assert_eq!(state.position_ms, 1500);
        assert_eq!(state.duration_ms, 214_000);
        assert_eq!(parsed["queueHead"].as_str(), Some("spotify:track:def"));
    }

    /// An absent state object must not read as playing at position 0.
    #[test]
    fn a_shapeless_state_reads_as_paused() {
        let state = player_state_from_json(&Value::Null);
        assert!(state.is_paused);
        assert_eq!(state.track_uri, None);
        assert_eq!(state.position_ms, 0);
    }

    #[test]
    fn a_missing_or_negative_duration_reads_as_zero() {
        assert_eq!(non_negative_u64(&Value::Null), 0);
        assert_eq!(non_negative_u64(&serde_json::json!(-5)), 0);
        assert_eq!(non_negative_u64(&serde_json::json!(1234.7)), 1234);
        assert_eq!(non_negative_u64(&serde_json::json!(1234)), 1234);
    }
}
