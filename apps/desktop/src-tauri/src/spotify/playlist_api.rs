use super::cdp::CdpClient;
use super::registry::ensure_script;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;

/// How long a single playlist fetch may take before it reads as unreachable.
///
/// CDP's own `timeout` bounds script *execution*; it does not cancel a promise
/// the script is awaiting. `getPlaylist` returns a promise, so a client that
/// never settles it would hang this call forever without a timeout here. Kept
/// under the CDP timeout so the two do not race.
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

/// The exact message the client's playlist service rejects with when asked for
/// a playlist that does not exist. Verified against the signed-in client: the
/// error carries no status and no code, so the message is the only
/// discriminator available.
const GONE_MESSAGE: &str = "Invalid playlist or members response!";

/// Stashes Spotify's internal playlist service on `window.__playlistApi`.
///
/// The registry no longer registers a bare `PlaylistAPI`; it registers
/// `ListPlatformAPI`, which holds the classic playlist client on its
/// `_playlistAPI` field. That inner object is what exposes
/// `getPlaylist(uri)`, so it is what gets stashed. Idempotent: safe to
/// evaluate repeatedly, e.g. after a page reload invalidates the stash.
static ENSURE_PLAYLIST_API_JS: LazyLock<String> = LazyLock::new(|| {
    ensure_script(
        "__playlistApi",
        r#"(() => {
    const api = resolveService("ListPlatformAPI")._playlistAPI;
    if (!api) throw new Error("ListPlatformAPI has no _playlistAPI");
    return api;
  })()"#,
    )
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistContents {
    pub name: String,
    /// Whether the signed-in user may add tracks to this playlist. False for
    /// someone else's: a linked playlist can be anyone's, and only the owner
    /// can write to it.
    pub can_add: bool,
    /// Whether rows may be removed or reordered. Spotify tracks this apart
    /// from adding, so a playlist can allow one and refuse the other.
    pub can_edit_items: bool,
    pub tracks: Vec<PlaylistTrack>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub uri: String,
    pub name: String,
    pub artist: String,
    /// Spotify's identity for this row in this playlist. `remove` and `move`
    /// address rows by uid, not by track uri, so this is what makes either
    /// possible.
    pub uid: String,
}

/// Why a playlist fetch produced nothing.
///
/// These two must never be confused at the call site. `Gone` is Spotify
/// answering that no such playlist exists, and the app acts on it by dropping
/// the linked playlist. `Unreachable` is every case where we did not get an
/// answer at all — client closed, connection dropped, call hung, service
/// missing — and the app must leave the playlist untouched.
///
/// Every ambiguous case classifies as `Unreachable`. A wrong `Unreachable`
/// costs a retry; a wrong `Gone` deletes the user's playlist.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlaylistError {
    Gone { message: String },
    Unreachable { message: String },
}

impl PlaylistError {
    fn unreachable(message: impl std::fmt::Display) -> Self {
        Self::Unreachable {
            message: message.to_string(),
        }
    }

    /// Getting to the client failed, so there is no verdict about the
    /// playlist. Always unreachable.
    pub(super) fn unreachable_from(error: impl std::fmt::Display) -> Self {
        Self::unreachable(error)
    }

    /// The failure text, for the session to judge whether the connection
    /// itself has stopped meaning anything.
    pub(super) fn message(&self) -> String {
        match self {
            Self::Gone { message } | Self::Unreachable { message } => message.clone(),
        }
    }
}

/// Classifies what the page-side fetch reported as its failure.
///
/// Only the client's own "no such playlist" rejection counts as gone, matched
/// on the exact message because that error carries nothing else to key on. If
/// Spotify ever rewords it this stops matching and linked playlists simply
/// stop auto-dropping — the safe direction to fail in.
fn classify_js_failure(message: &str) -> PlaylistError {
    if message.contains(GONE_MESSAGE) {
        PlaylistError::Gone {
            message: message.to_string(),
        }
    } else {
        PlaylistError::unreachable(message)
    }
}

async fn ensure_playlist_api(cdp: &CdpClient) -> Result<()> {
    cdp.evaluate(&ENSURE_PLAYLIST_API_JS).await?;
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
/// A playlist the client refused to produce is reported as `Gone`; every other
/// failure, including a hang, is `Unreachable`.
pub async fn fetch_playlist(
    cdp: &CdpClient,
    uri: String,
) -> std::result::Result<PlaylistContents, PlaylistError> {
    match tokio::time::timeout(FETCH_TIMEOUT, fetch_inner(cdp, uri)).await {
        Ok(result) => result,
        Err(_) => Err(PlaylistError::unreachable(
            "timed out waiting for Spotify to return the playlist",
        )),
    }
}

async fn fetch_inner(
    cdp: &CdpClient,
    uri: String,
) -> std::result::Result<PlaylistContents, PlaylistError> {
    // A malformed link is the caller's mistake, not a missing playlist. It is
    // not "gone": nothing was ever linked to drop.
    let playlist_uri = normalise_playlist_uri(&uri).map_err(PlaylistError::unreachable)?;
    ensure_playlist_api(cdp)
        .await
        .map_err(PlaylistError::unreachable)?;

    let uri_json = serde_json::to_string(&playlist_uri).map_err(PlaylistError::unreachable)?;

    // The page catches its own rejection and reports it as data. Letting it
    // throw would surface here as an opaque `JS exception:` blob, and telling
    // "this playlist is gone" from "the call broke" would mean substring
    // matching a serialized stack trace.
    let expr = format!(
        r#"(async () => {{
            try {{
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
                        uid: item.uid ?? "",
                    }}));
                return JSON.stringify({{
                    ok: true,
                    name: r?.metadata?.name ?? "",
                    canAdd: r?.metadata?.canAdd === true,
                    canEditItems: r?.metadata?.canEditItems === true,
                    tracks,
                }});
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
        PlaylistError::unreachable(format!("getPlaylist did not return a JSON string: {value}"))
    })?;
    let parsed: Value = serde_json::from_str(json_str).map_err(PlaylistError::unreachable)?;

    parse_fetch_result(&parsed)
}

/// Turns the page's reported result into contents or a classified failure.
fn parse_fetch_result(parsed: &Value) -> std::result::Result<PlaylistContents, PlaylistError> {
    if parsed["ok"].as_bool() != Some(true) {
        let message = parsed["error"].as_str().unwrap_or("getPlaylist failed");
        return Err(classify_js_failure(message));
    }

    let name = parsed["name"].as_str().unwrap_or_default().to_string();
    let tracks = parsed["tracks"]
        .as_array()
        .map(|items| items.iter().filter_map(track_from_json).collect())
        .unwrap_or_default();

    Ok(PlaylistContents {
        name,
        // Absent reads as false: offering an edit that the client will refuse
        // is worse than hiding one that would have worked.
        can_add: parsed["canAdd"].as_bool().unwrap_or(false),
        can_edit_items: parsed["canEditItems"].as_bool().unwrap_or(false),
        tracks,
    })
}

/// Appends tracks to a Spotify playlist through the signed-in client.
///
/// The playlist service owns the content, so an add goes to Spotify rather
/// than to any local copy. A linked playlist then picks the tracks up on its
/// next sync.
pub async fn add_to_playlist(
    cdp: &CdpClient,
    uri: String,
    track_uris: Vec<String>,
) -> std::result::Result<(), PlaylistError> {
    match tokio::time::timeout(FETCH_TIMEOUT, add_inner(cdp, uri, track_uris)).await {
        Ok(result) => result,
        Err(_) => Err(PlaylistError::unreachable(
            "timed out waiting for Spotify to add the tracks",
        )),
    }
}

async fn add_inner(
    cdp: &CdpClient,
    uri: String,
    track_uris: Vec<String>,
) -> std::result::Result<(), PlaylistError> {
    if track_uris.is_empty() {
        return Ok(());
    }

    let playlist_uri = normalise_playlist_uri(&uri).map_err(PlaylistError::unreachable)?;
    ensure_playlist_api(cdp)
        .await
        .map_err(PlaylistError::unreachable)?;

    let uri_json = serde_json::to_string(&playlist_uri).map_err(PlaylistError::unreachable)?;
    let tracks_json = serde_json::to_string(&track_uris).map_err(PlaylistError::unreachable)?;

    // The position argument is required and destructured, so it cannot be
    // omitted: `undefined` and `null` both throw. `{before:{type:"end"}}` is
    // the append spec. Verified against the signed-in client.
    let expr = format!(
        r#"(async () => {{
            try {{
                await window.__playlistApi.add(
                    {uri_json},
                    {tracks_json},
                    {{ before: {{ type: "end" }} }},
                );
                return JSON.stringify({{ ok: true }});
            }} catch (e) {{
                return JSON.stringify({{ ok: false, error: String(e?.message ?? e) }});
            }}
        }})()"#
    );

    let value: Value = cdp.evaluate(&expr).await.map_err(PlaylistError::unreachable)?;
    let json_str = value.as_str().ok_or_else(|| {
        PlaylistError::unreachable(format!("add did not return a JSON string: {value}"))
    })?;
    let parsed: Value = serde_json::from_str(json_str).map_err(PlaylistError::unreachable)?;

    if parsed["ok"].as_bool() == Some(true) {
        return Ok(());
    }
    Err(classify_js_failure(
        parsed["error"].as_str().unwrap_or("add failed"),
    ))
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
        uid: item
            .get("uid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// One row of a playlist, as the client addresses it for a write.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRef {
    pub uid: String,
    pub uri: String,
}

/// Removes rows from a Spotify playlist.
///
/// Rows are addressed by `uid`, not by track uri: the uid is what names this
/// occurrence of the track in this playlist.
pub async fn remove_from_playlist(
    cdp: &CdpClient,
    uri: String,
    rows: Vec<RowRef>,
) -> std::result::Result<(), PlaylistError> {
    match tokio::time::timeout(FETCH_TIMEOUT, remove_inner(cdp, uri, rows)).await {
        Ok(result) => result,
        Err(_) => Err(PlaylistError::unreachable(
            "timed out waiting for Spotify to remove the tracks",
        )),
    }
}

async fn remove_inner(
    cdp: &CdpClient,
    uri: String,
    rows: Vec<RowRef>,
) -> std::result::Result<(), PlaylistError> {
    if rows.is_empty() {
        return Ok(());
    }
    let playlist_uri = normalise_playlist_uri(&uri).map_err(PlaylistError::unreachable)?;
    ensure_playlist_api(cdp)
        .await
        .map_err(PlaylistError::unreachable)?;

    let uri_json = serde_json::to_string(&playlist_uri).map_err(PlaylistError::unreachable)?;
    let rows_json = rows_to_json(&rows)?;

    let expr = format!(
        r#"(async () => {{
            try {{
                await window.__playlistApi.remove({uri_json}, {rows_json});
                return JSON.stringify({{ ok: true }});
            }} catch (e) {{
                return JSON.stringify({{ ok: false, error: String(e?.message ?? e) }});
            }}
        }})()"#
    );

    run_write(cdp, &expr, "remove failed").await
}

/// Moves one row so it sits just before `before_uid`, or to the end when that
/// is `None`.
///
/// The two position specs are not symmetric, and the difference matters:
/// `{before:{type:"end"}}` appends for `add` but sends a moved row to the
/// *front*. Moving to the end is `{after:{type:"ITEM", uid: <last row>}}`, so
/// the caller passes the row to land after.
pub async fn move_in_playlist(
    cdp: &CdpClient,
    uri: String,
    rows: Vec<RowRef>,
    before_uid: Option<String>,
    after_uid: Option<String>,
) -> std::result::Result<(), PlaylistError> {
    match tokio::time::timeout(
        FETCH_TIMEOUT,
        move_inner(cdp, uri, rows, before_uid, after_uid),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(PlaylistError::unreachable(
            "timed out waiting for Spotify to reorder the playlist",
        )),
    }
}

async fn move_inner(
    cdp: &CdpClient,
    uri: String,
    rows: Vec<RowRef>,
    before_uid: Option<String>,
    after_uid: Option<String>,
) -> std::result::Result<(), PlaylistError> {
    if rows.is_empty() {
        return Ok(());
    }
    let playlist_uri = normalise_playlist_uri(&uri).map_err(PlaylistError::unreachable)?;
    ensure_playlist_api(cdp)
        .await
        .map_err(PlaylistError::unreachable)?;

    let uri_json = serde_json::to_string(&playlist_uri).map_err(PlaylistError::unreachable)?;
    let rows_json = rows_to_json(&rows)?;
    let position_json = position_spec(before_uid.as_deref(), after_uid.as_deref())?;

    let expr = format!(
        r#"(async () => {{
            try {{
                await window.__playlistApi.move({uri_json}, {rows_json}, {position_json});
                return JSON.stringify({{ ok: true }});
            }} catch (e) {{
                return JSON.stringify({{ ok: false, error: String(e?.message ?? e) }});
            }}
        }})()"#
    );

    run_write(cdp, &expr, "move failed").await
}

/// The position argument for a move.
///
/// Verified against the signed-in client: `{before:{type:"ITEM", uid}}` puts
/// the row ahead of that one, and `{after:{type:"ITEM", uid}}` behind it.
/// There is no "end" form that works for a move, so landing at the end means
/// naming the row currently last.
fn position_spec(
    before_uid: Option<&str>,
    after_uid: Option<&str>,
) -> std::result::Result<String, PlaylistError> {
    let value = match (before_uid, after_uid) {
        (Some(uid), _) => serde_json::json!({ "before": { "type": "ITEM", "uid": uid } }),
        (None, Some(uid)) => serde_json::json!({ "after": { "type": "ITEM", "uid": uid } }),
        (None, None) => {
            return Err(PlaylistError::unreachable(
                "a move needs a row to land before or after",
            ))
        }
    };
    serde_json::to_string(&value).map_err(PlaylistError::unreachable)
}

fn rows_to_json(rows: &[RowRef]) -> std::result::Result<String, PlaylistError> {
    let pairs: Vec<Value> = rows
        .iter()
        .map(|row| serde_json::json!({ "uid": row.uid, "uri": row.uri }))
        .collect();
    serde_json::to_string(&pairs).map_err(PlaylistError::unreachable)
}

/// Runs a write expression and classifies whatever the page reported.
async fn run_write(
    cdp: &CdpClient,
    expr: &str,
    fallback: &str,
) -> std::result::Result<(), PlaylistError> {
    let value: Value = cdp.evaluate(expr).await.map_err(PlaylistError::unreachable)?;
    let json_str = value.as_str().ok_or_else(|| {
        PlaylistError::unreachable(format!("write did not return a JSON string: {value}"))
    })?;
    let parsed: Value = serde_json::from_str(json_str).map_err(PlaylistError::unreachable)?;

    if parsed["ok"].as_bool() == Some(true) {
        return Ok(());
    }
    Err(classify_js_failure(
        parsed["error"].as_str().unwrap_or(fallback),
    ))
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

    fn is_gone(error: &PlaylistError) -> bool {
        matches!(error, PlaylistError::Gone { .. })
    }

    #[test]
    fn classifies_the_clients_missing_playlist_rejection_as_gone() {
        assert!(is_gone(&classify_js_failure(
            "Invalid playlist or members response!"
        )));
    }

    #[test]
    fn classifies_the_rejection_when_it_arrives_wrapped() {
        assert!(is_gone(&classify_js_failure(
            "Error: Invalid playlist or members response!"
        )));
    }

    /// The safe direction: anything we do not positively recognise leaves the
    /// linked playlist alone rather than dropping it.
    #[test]
    fn classifies_every_other_failure_as_unreachable() {
        for message in [
            "Failed to fetch",
            "no React fiber found",
            "ListPlatformAPI has no _playlistAPI",
            "NetworkError when attempting to fetch resource.",
            "invalid playlist",
            "",
        ] {
            assert!(
                !is_gone(&classify_js_failure(message)),
                "expected unreachable for {message:?}"
            );
        }
    }

    #[test]
    fn parses_a_successful_result() {
        let value = serde_json::json!({
            "ok": true,
            "name": "Late night",
            "canAdd": true,
            "tracks": [
                { "uri": "spotify:track:aaaa1111", "name": "One", "artist": "A" },
            ],
        });
        let contents = parse_fetch_result(&value).unwrap();
        assert_eq!(contents.name, "Late night");
        assert!(contents.can_add);
        assert_eq!(contents.tracks.len(), 1);
        assert_eq!(contents.tracks[0].uri, "spotify:track:aaaa1111");
    }

    #[test]
    fn parses_an_empty_playlist() {
        let value = serde_json::json!({ "ok": true, "name": "Nothing", "tracks": [] });
        let contents = parse_fetch_result(&value).unwrap();
        assert_eq!(contents.name, "Nothing");
        assert!(contents.tracks.is_empty());
    }

    /// Someone else's playlist. Absent or false both mean no write.
    #[test]
    fn reads_a_playlist_we_cannot_add_to() {
        let refused = serde_json::json!({ "ok": true, "name": "Theirs", "canAdd": false, "tracks": [] });
        assert!(!parse_fetch_result(&refused).unwrap().can_add);

        let absent = serde_json::json!({ "ok": true, "name": "Old", "tracks": [] });
        assert!(!parse_fetch_result(&absent).unwrap().can_add);
    }

    /// Editing rows is tracked apart from adding; both default to refused.
    #[test]
    fn reads_the_row_editing_permission() {
        let allowed = serde_json::json!({
            "ok": true, "name": "Mine", "canEditItems": true, "tracks": []
        });
        assert!(parse_fetch_result(&allowed).unwrap().can_edit_items);

        let absent = serde_json::json!({ "ok": true, "name": "Old", "tracks": [] });
        assert!(!parse_fetch_result(&absent).unwrap().can_edit_items);
    }

    #[test]
    fn carries_each_rows_uid() {
        let value = serde_json::json!({
            "ok": true,
            "name": "Mine",
            "tracks": [
                { "uri": "spotify:track:aaaa1111", "name": "One", "artist": "A", "uid": "abc123" },
            ],
        });
        assert_eq!(parse_fetch_result(&value).unwrap().tracks[0].uid, "abc123");
    }

    /// The two specs are not symmetric — `{before:{type:"end"}}` appends for
    /// `add` but sends a moved row to the front — so a move always names a row.
    #[test]
    fn builds_the_move_position_from_a_named_row() {
        assert_eq!(
            position_spec(Some("row1"), None).unwrap(),
            r#"{"before":{"type":"ITEM","uid":"row1"}}"#
        );
        assert_eq!(
            position_spec(None, Some("row9")).unwrap(),
            r#"{"after":{"type":"ITEM","uid":"row9"}}"#
        );
    }

    #[test]
    fn before_wins_when_both_are_given() {
        assert_eq!(
            position_spec(Some("row1"), Some("row9")).unwrap(),
            r#"{"before":{"type":"ITEM","uid":"row1"}}"#
        );
    }

    #[test]
    fn a_move_with_no_target_is_refused() {
        assert!(position_spec(None, None).is_err());
    }

    #[test]
    fn reports_a_missing_playlist_as_gone() {
        let value = serde_json::json!({
            "ok": false,
            "error": "Invalid playlist or members response!",
        });
        assert!(is_gone(&parse_fetch_result(&value).unwrap_err()));
    }

    /// A result that is neither a success nor a recognised failure must not
    /// read as gone.
    #[test]
    fn reports_a_shapeless_result_as_unreachable() {
        let value = serde_json::json!({ "unexpected": true });
        assert!(!is_gone(&parse_fetch_result(&value).unwrap_err()));
    }
}
