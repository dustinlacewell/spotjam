use super::cdp::CdpClient;
use super::playlist_api::{validated_id, PlaylistError};
use super::registry::ensure_script;
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;

/// How long a single list fetch may take before it reads as unreachable.
///
/// Same reasoning as the playlist fetch: CDP bounds script execution but does
/// not cancel a promise, so a client that never settles `getListContents`
/// would hang this call forever. Kept under the CDP timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

/// The exact message the client's list service rejects with when asked for a
/// list that does not exist. Verified against the signed-in client: resolving
/// a bogus `spotify:album:` or `spotify:artist:` URI rejects with this and
/// nothing else, so the message is the only discriminator available.
const GONE_MESSAGE: &str = "Invalid list response!";

/// Stashes xpui's list platform service on `window.__listPlatformApi`.
///
/// `ListPlatformAPI` is the one registry service that serves static track
/// lists of every kind: `getPlaylist` (via its `_playlistAPI` field) covers
/// playlists, and `getListContents(uri)` covers albums and artists — the
/// client itself treats an album's tracks and an artist's popular tracks as
/// "lists". Verified against the live client:
///
/// - `spotify:album:ID` resolves the album's tracks in album order.
/// - `spotify:artist:ID` resolves the artist's tracks in Spotify's own
///   ordering (the `popular-release-segments-main-roles` list).
/// - The whole list comes back in one call (`limit` echoes 0 with
///   `totalLength` set), so there is no paging loop.
/// - A list that does not exist rejects with `Invalid list response!`.
///
/// Idempotent: safe to evaluate repeatedly, e.g. after a page reload
/// invalidates the stash.
static ENSURE_LIST_API_JS: LazyLock<String> = LazyLock::new(|| {
    ensure_script(
        "__listPlatformApi",
        r#"resolveService("ListPlatformAPI")"#,
    )
});

/// A track row of a static list, as the client addresses it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticListTrack {
    pub uri: String,
}

/// A static track list as the client's list service reports it.
///
/// Album and artist lists carry no display names and no per-row durations —
/// the rows are bare `spotify:track:` references — so neither is produced
/// here. Durations are resolved later by the same metadata lookup the
/// playlist enqueue path already runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticListContents {
    pub tracks: Vec<StaticListTrack>,
}

/// Fetches the track list of an album or artist link.
///
/// `uri` may be a `spotify:album:`/`spotify:artist:` URI or an
/// `open.spotify.com` URL; both normalise to the URI form.
///
/// Only `spotify:track:` entries survive; anything else the list contains is
/// dropped because the player cannot be handed those URIs.
///
/// Failure semantics are the playlist's: a list the client refused to produce
/// is reported as `Gone`; every other failure, including a hang, is
/// `Unreachable`. A malformed link is `Rejected`.
pub async fn fetch_list(
    cdp: &CdpClient,
    uri: String,
) -> std::result::Result<StaticListContents, PlaylistError> {
    match tokio::time::timeout(FETCH_TIMEOUT, fetch_inner(cdp, uri)).await {
        Ok(result) => result,
        Err(_) => Err(PlaylistError::unreachable(
            "timed out waiting for Spotify to return the track list",
        )),
    }
}

async fn fetch_inner(
    cdp: &CdpClient,
    uri: String,
) -> std::result::Result<StaticListContents, PlaylistError> {
    // A malformed link is the caller's mistake, not a missing list. It is not
    // "gone": nothing was ever linked to drop.
    let list_uri = normalise_list_uri(&uri).map_err(PlaylistError::rejected)?;
    cdp.evaluate(&ENSURE_LIST_API_JS)
        .await
        .map_err(PlaylistError::unreachable)?;

    let uri_json = serde_json::to_string(&list_uri).map_err(PlaylistError::unreachable)?;

    // The page catches its own rejection and reports it as data, so
    // "this list is gone" is distinguishable from "the call broke" without
    // substring-matching a serialized stack trace.
    let expr = format!(
        r#"(async () => {{
            try {{
                const r = await window.__listPlatformApi.getListContents({uri_json});
                const tracks = (r?.data ?? [])
                    .filter((item) => typeof item?.uri === "string"
                        && item.uri.startsWith("spotify:track:"))
                    .map((item) => ({{ uri: item.uri }}));
                return JSON.stringify({{ ok: true, tracks }});
            }} catch (e) {{
                return JSON.stringify({{
                    ok: false,
                    error: String(e?.message ?? e),
                }});
            }}
        }})()"#
    );

    let value: Value = cdp.evaluate(&expr).await.map_err(PlaylistError::unreachable)?;
    let json_str = value.as_str().ok_or_else(|| {
        PlaylistError::unreachable(format!(
            "getListContents did not return a JSON string: {value}"
        ))
    })?;
    let parsed: Value = serde_json::from_str(json_str).map_err(PlaylistError::unreachable)?;

    parse_fetch_result(&parsed)
}

/// Turns the page's reported result into contents or a classified failure.
fn parse_fetch_result(
    parsed: &Value,
) -> std::result::Result<StaticListContents, PlaylistError> {
    if parsed["ok"].as_bool() != Some(true) {
        let message = parsed["error"].as_str().unwrap_or("getListContents failed");
        return Err(classify_js_failure(message));
    }

    let tracks = parsed["tracks"]
        .as_array()
        .map(|items| items.iter().filter_map(track_from_json).collect())
        .unwrap_or_default();

    Ok(StaticListContents { tracks })
}

/// Only the client's own "no such list" rejection counts as gone, matched on
/// the exact message because that error carries nothing else to key on. If
/// Spotify ever rewords it this stops matching and static lists simply stop
/// resolving — the safe direction to fail in.
fn classify_js_failure(message: &str) -> PlaylistError {
    if message.contains(GONE_MESSAGE) {
        PlaylistError::Gone {
            message: message.to_string(),
        }
    } else {
        PlaylistError::unreachable(message)
    }
}

fn track_from_json(item: &Value) -> Option<StaticListTrack> {
    Some(StaticListTrack {
        uri: item.get("uri").and_then(Value::as_str)?.to_string(),
    })
}

/// Accepts a `spotify:album:`/`spotify:artist:` URI or an open.spotify.com
/// album/artist URL (with or without a scheme, locale segment, or query
/// string) and returns the URI form.
fn normalise_list_uri(input: &str) -> anyhow::Result<String> {
    let trimmed = input.trim();
    if let Some(kind) = ["album", "artist"].iter().find(|kind| {
        trimmed.starts_with(&format!("spotify:{kind}:"))
            || trimmed.contains(&format!("/{kind}/"))
    }) {
        let id = if let Some(rest) = trimmed.strip_prefix(&format!("spotify:{kind}:")) {
            rest.split(['?', ':']).next().unwrap_or_default()
        } else {
            let index = trimmed.find(&format!("/{kind}/")).unwrap();
            let rest = &trimmed[index + kind.len() + 2..];
            rest.split(['/', '?', '#']).next().unwrap_or_default()
        };
        return validated_id(id).map(|id| format!("spotify:{kind}:{id}"));
    }

    Err(anyhow::anyhow!(
        "not a Spotify album or artist URI or URL: {trimmed}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_album_uri() {
        assert_eq!(
            normalise_list_uri("spotify:album:4aawyAB9vmqN3uQ7FjRGTy").unwrap(),
            "spotify:album:4aawyAB9vmqN3uQ7FjRGTy"
        );
    }

    #[test]
    fn accepts_artist_uri() {
        assert_eq!(
            normalise_list_uri("spotify:artist:0OdUWJ0sBjDrqHygGUXeCF").unwrap(),
            "spotify:artist:0OdUWJ0sBjDrqHygGUXeCF"
        );
    }

    #[test]
    fn accepts_album_url_with_query() {
        assert_eq!(
            normalise_list_uri(
                "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc123"
            )
            .unwrap(),
            "spotify:album:4aawyAB9vmqN3uQ7FjRGTy"
        );
    }

    #[test]
    fn accepts_locale_segment_and_bare_host() {
        assert_eq!(
            normalise_list_uri("open.spotify.com/intl-de/artist/0OdUWJ0sBjDrqHygGUXeCF").unwrap(),
            "spotify:artist:0OdUWJ0sBjDrqHygGUXeCF"
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(
            normalise_list_uri("  spotify:album:abc123  ").unwrap(),
            "spotify:album:abc123"
        );
    }

    #[test]
    fn rejects_playlist_and_track_uris() {
        assert!(normalise_list_uri("spotify:playlist:4GMggdudXVrZDlypjvNxtZ").is_err());
        assert!(normalise_list_uri("spotify:track:2OWfdex8Sx9e6RqUeFfUKW").is_err());
        assert!(normalise_list_uri("https://open.spotify.com/playlist/xyz").is_err());
        assert!(normalise_list_uri("").is_err());
    }

    #[test]
    fn rejects_malformed_id() {
        assert!(normalise_list_uri("spotify:album:").is_err());
        assert!(normalise_list_uri("https://open.spotify.com/album/").is_err());
        assert!(normalise_list_uri("spotify:artist:").is_err());
    }

    /// ADVERSARY. `normalise_list_uri` echoes the caller's raw paste into its
    /// error, and `with_client_typed` feeds whatever `describe` hands back to
    /// the stale-connection classifier, which substring-matches
    /// `registry::STALE_PREFIX`. A rejection must never be describable at
    /// all: the classifier may never see the paste.
    #[test]
    fn a_validation_rejection_is_never_described_to_the_classifier() {
        let pasted = format!("spotify:album: {} no React fiber found", super::super::registry::STALE_PREFIX);
        let rejection = normalise_list_uri(&pasted).unwrap_err();

        let as_error = PlaylistError::rejected(rejection);
        assert!(
            matches!(as_error, PlaylistError::Rejected { .. }),
            "a URI the parser refuses must classify as a rejection"
        );
        assert!(
            as_error.describe().is_none(),
            "a rejection may never reach the classifier: its message embeds the paste"
        );
    }

    #[test]
    fn classifies_the_clients_missing_list_rejection_as_gone() {
        match classify_js_failure("Invalid list response!") {
            PlaylistError::Gone { .. } => {}
            other => panic!("expected Gone, got {other:?}"),
        }
        match classify_js_failure("Error: Invalid list response!") {
            PlaylistError::Gone { .. } => {}
            other => panic!("expected Gone, got {other:?}"),
        }
    }

    /// The safe direction: anything we do not positively recognise leaves the
    /// caller to treat it as unreachable rather than gone.
    #[test]
    fn classifies_every_other_failure_as_unreachable() {
        for message in [
            "Failed to fetch",
            "no React fiber found",
            "NetworkError when attempting to fetch resource.",
            "Invalid playlist or members response!",
            "",
        ] {
            assert!(
                !matches!(classify_js_failure(message), PlaylistError::Gone { .. }),
                "expected unreachable for {message:?}"
            );
        }
    }

    #[test]
    fn parses_a_successful_result() {
        let value = serde_json::json!({
            "ok": true,
            "tracks": [
                { "uri": "spotify:track:aaaa1111", "uid": "abc123" },
                { "uri": "spotify:track:bbbb2222" },
            ],
        });
        let contents = parse_fetch_result(&value).unwrap();
        assert_eq!(contents.tracks.len(), 2);
        assert_eq!(contents.tracks[0].uri, "spotify:track:aaaa1111");
        assert_eq!(contents.tracks[1].uri, "spotify:track:bbbb2222");
    }

    /// The non-track filter lives in the page-side script; the parser's job is
    /// to keep every row that carries a uri and tolerate the rest.
    #[test]
    fn keeps_every_row_that_carries_a_uri() {
        let value = serde_json::json!({
            "ok": true,
            "tracks": [
                { "uri": "spotify:track:aaaa1111", "uid": "u3" },
                { "name": "no uri" },
                { "uid": "orphan uid" },
            ],
        });
        let contents = parse_fetch_result(&value).unwrap();
        assert_eq!(contents.tracks.len(), 1);
        assert_eq!(contents.tracks[0].uri, "spotify:track:aaaa1111");
    }

    #[test]
    fn parses_an_empty_list() {
        let value = serde_json::json!({ "ok": true, "tracks": [] });
        let contents = parse_fetch_result(&value).unwrap();
        assert!(contents.tracks.is_empty());
    }

    #[test]
    fn reports_a_missing_list_as_gone() {
        let value = serde_json::json!({
            "ok": false,
            "error": "Invalid list response!",
        });
        assert!(matches!(
            parse_fetch_result(&value).unwrap_err(),
            PlaylistError::Gone { .. }
        ));
    }

    #[test]
    fn reports_a_shapeless_result_as_unreachable() {
        let value = serde_json::json!({ "unexpected": true });
        assert!(!matches!(
            parse_fetch_result(&value).unwrap_err(),
            PlaylistError::Gone { .. }
        ));
    }
}