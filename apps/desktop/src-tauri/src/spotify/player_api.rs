use super::cdp::CdpClient;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;

/// Resolves the internal `PlayerAPI` service through the React fiber tree's
/// RegistryContext and stashes it on `window.__playerApi` for reuse across
/// calls. Idempotent: safe to evaluate repeatedly, e.g. after a page reload
/// invalidates the stash.
///
/// xpui registers services under `Symbol.for(name)` keys, so the key is
/// built here directly. Reading it out of a webpack module by numeric id
/// broke every time a Spotify update renumbered the bundle.
const ENSURE_PLAYER_API_JS: &str = r#"(() => {
  if (window.__playerApi) return true;
  const playerApiKey = Symbol.for("PlayerAPI");

  const all = document.querySelectorAll("*");
  let fiberRoot = null;
  for (const el of all) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (k) { fiberRoot = el[k]; break; }
  }
  if (!fiberRoot) throw new Error("no React fiber found");

  let registry = null;
  const seen = new Set();
  const queue = [fiberRoot];
  let visited = 0;
  while (queue.length && visited < 20000) {
    const f = queue.shift();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    visited++;
    const deps = f.dependencies;
    if (deps && deps.firstContext) {
      let ctx = deps.firstContext;
      while (ctx) {
        const val = ctx.memoizedValue;
        if (val && typeof val.resolve === "function") { registry = val; break; }
        ctx = ctx.next;
      }
    }
    if (registry) break;
    if (f.child) queue.push(f.child);
    if (f.sibling) queue.push(f.sibling);
  }
  if (!registry) throw new Error("no RegistryContext found in fiber tree");

  const playerApi = registry.resolve(playerApiKey);
  if (!playerApi) throw new Error("registry.resolve(PlayerAPI) returned falsy");
  window.__playerApi = playerApi;
  return true;
})()"#;

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
    cdp.evaluate(ENSURE_PLAYER_API_JS).await?;
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

pub async fn get_state(cdp: &CdpClient) -> Result<PlayerState> {
    ensure_player_api(cdp).await?;
    let value: Value = cdp
        .evaluate(
            r#"(async () => {
                const s = await window.__playerApi.getState();
                const isPaused = s?.isPaused ?? true;
                const base = s?.positionAsOfTimestamp ?? 0;
                const raw = isPaused
                    ? base
                    : base + (Date.now() - (s?.timestamp ?? Date.now()));
                return JSON.stringify({
                    trackUri: s?.item?.uri ?? null,
                    trackName: s?.item?.name ?? null,
                    isPaused,
                    positionMs: Math.max(0, Math.round(raw)),
                    durationMs: Math.max(0, Math.round(s?.duration ?? 0)),
                });
            })()"#,
        )
        .await?;

    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("getState did not return a JSON string: {value}"))?;
    let parsed: Value = serde_json::from_str(json_str)?;

    Ok(PlayerState {
        track_uri: parsed["trackUri"].as_str().map(String::from),
        track_name: parsed["trackName"].as_str().map(String::from),
        is_paused: parsed["isPaused"].as_bool().unwrap_or(true),
        position_ms: non_negative_u64(&parsed["positionMs"]),
        duration_ms: non_negative_u64(&parsed["durationMs"]),
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
    let expr = format!(
        r#"(async () => {{
            const api = window.__playerApi;
            await api.clearQueue();
            await api.addToQueue([{{ uri: {uri_json} }}]);
            return true;
        }})()"#
    );
    cdp.evaluate(&expr).await?;
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
/// Note that Spotify serves `getQueue()` from a cache refreshed by player
/// events, so a read issued in the same evaluation as a queue write still
/// sees the pre-write value. Reading in its own call, as here, is correct.
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
fn non_negative_u64(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| f.max(0.0) as u64))
        .unwrap_or(0)
}
