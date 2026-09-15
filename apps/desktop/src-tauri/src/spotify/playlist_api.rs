use super::cdp::CdpClient;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;

/// Resolves Spotify's internal playlist service the same way `player_api`
/// resolves `PlayerAPI`: build the `Symbol.for(name)` registry key, then look
/// it up in the React RegistryContext.
///
/// The registry no longer registers a bare `PlaylistAPI`; it registers
/// `ListPlatformAPI`, which holds the classic playlist client on its
/// `_playlistAPI` field. That inner object is what exposes
/// `getPlaylist(uri)`, so it is what gets stashed.
///
/// Stashed on `window.__playlistApi` for reuse. Idempotent: safe to evaluate
/// repeatedly, e.g. after a page reload invalidates the stash.
const ENSURE_PLAYLIST_API_JS: &str = r#"(() => {
  if (window.__playlistApi) return true;
  const listPlatformKey = Symbol.for("ListPlatformAPI");

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

  const listPlatform = registry.resolve(listPlatformKey);
  if (!listPlatform) throw new Error("registry.resolve(ListPlatformAPI) returned falsy");
  const playlistApi = listPlatform._playlistAPI;
  if (!playlistApi) throw new Error("ListPlatformAPI has no _playlistAPI");
  window.__playlistApi = playlistApi;
  return true;
})()"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistContents {
    pub name: String,
    pub tracks: Vec<PlaylistTrack>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub uri: String,
    pub name: String,
    pub artist: String,
}

async fn ensure_playlist_api(cdp: &CdpClient) -> Result<()> {
    cdp.evaluate(ENSURE_PLAYLIST_API_JS).await?;
    Ok(())
}

/// Fetches a playlist's name and full track list.
///
/// `uri` may be either a `spotify:playlist:ID` URI or an
/// `open.spotify.com/playlist/ID` URL; both normalise to the former.
///
/// `getPlaylist` returns the whole list in one call — it ignores `limit` and
/// `offset` and echoes back `limit == totalLength` — so there is no paging
/// loop here. Verified against playlists of 71, 5295 and 10000 items.
///
/// Only `spotify:track:` entries survive; local files and episodes are dropped
/// because the player cannot be handed their URIs the same way.
pub async fn fetch_playlist(cdp: &CdpClient, uri: String) -> Result<PlaylistContents> {
    let playlist_uri = normalise_playlist_uri(&uri)?;
    ensure_playlist_api(cdp).await?;

    let uri_json = serde_json::to_string(&playlist_uri)?;
    let expr = format!(
        r#"(async () => {{
            const r = await window.__playlistApi.getPlaylist({uri_json});
            const tracks = (r?.contents?.items ?? [])
                .filter((item) => typeof item?.uri === "string"
                    && item.uri.startsWith("spotify:track:"))
                .map((item) => ({{
                    uri: item.uri,
                    name: item.name ?? "",
                    artist: (item.artists ?? [])
                        .map((a) => a?.name)
                        .filter((n) => typeof n === "string" && n.length > 0)
                        .join(", "),
                }}));
            return JSON.stringify({{ name: r?.metadata?.name ?? "", tracks }});
        }})()"#
    );

    let value: Value = cdp.evaluate(&expr).await?;
    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("getPlaylist did not return a JSON string: {value}"))?;
    let parsed: Value = serde_json::from_str(json_str)?;

    let name = parsed["name"].as_str().unwrap_or_default().to_string();
    let tracks = parsed["tracks"]
        .as_array()
        .map(|items| items.iter().filter_map(track_from_json).collect())
        .unwrap_or_default();

    Ok(PlaylistContents { name, tracks })
}

fn track_from_json(item: &Value) -> Option<PlaylistTrack> {
    Some(PlaylistTrack {
        uri: item.get("uri").and_then(Value::as_str)?.to_string(),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        artist: item
            .get("artist")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// Accepts `spotify:playlist:ID` or an open.spotify.com playlist URL (with or
/// without a scheme, locale segment, or query string) and returns the URI form.
fn normalise_playlist_uri(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if let Some(id) = trimmed.strip_prefix("spotify:playlist:") {
        let id = id.split(['?', ':']).next().unwrap_or_default();
        return validated_id(id).map(|id| format!("spotify:playlist:{id}"));
    }

    if let Some(index) = trimmed.find("/playlist/") {
        let rest = &trimmed[index + "/playlist/".len()..];
        let id = rest.split(['/', '?', '#']).next().unwrap_or_default();
        return validated_id(id).map(|id| format!("spotify:playlist:{id}"));
    }

    Err(anyhow!("not a Spotify playlist URI or URL: {trimmed}"))
}

fn validated_id(id: &str) -> Result<&str> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err(anyhow!("invalid Spotify playlist id: {id:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_uri() {
        assert_eq!(
            normalise_playlist_uri("spotify:playlist:4GMggdudXVrZDlypjvNxtZ").unwrap(),
            "spotify:playlist:4GMggdudXVrZDlypjvNxtZ"
        );
    }

    #[test]
    fn accepts_https_url_with_query() {
        assert_eq!(
            normalise_playlist_uri(
                "https://open.spotify.com/playlist/4GMggdudXVrZDlypjvNxtZ?si=abc123"
            )
            .unwrap(),
            "spotify:playlist:4GMggdudXVrZDlypjvNxtZ"
        );
    }

    #[test]
    fn accepts_locale_segment_and_bare_host() {
        assert_eq!(
            normalise_playlist_uri("open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M")
                .unwrap(),
            "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(
            normalise_playlist_uri("  spotify:playlist:abc123  ").unwrap(),
            "spotify:playlist:abc123"
        );
    }

    #[test]
    fn rejects_other_entity_types() {
        assert!(normalise_playlist_uri("spotify:track:2OWfdex8Sx9e6RqUeFfUKW").is_err());
        assert!(normalise_playlist_uri("https://open.spotify.com/album/xyz").is_err());
        assert!(normalise_playlist_uri("").is_err());
    }

    #[test]
    fn rejects_malformed_id() {
        assert!(normalise_playlist_uri("spotify:playlist:").is_err());
        assert!(normalise_playlist_uri("https://open.spotify.com/playlist/").is_err());
    }
}
