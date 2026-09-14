use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Sent to the webview as-is. Field names stay snake_case on the wire;
/// track-metadata.ts maps `thumbnail_url` to `thumbnailUrl` itself.
#[derive(Debug, Clone, Serialize)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Deserialize)]
struct OembedResponse {
    title: Option<String>,
    thumbnail_url: Option<String>,
}

const DESKTOP_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NEXT_DATA_OPEN: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
const NEXT_DATA_CLOSE: &str = "</script>";

/// Looks up display metadata for a Spotify track. Runs from the Rust side
/// because open.spotify.com sends no Access-Control-Allow-Origin header, so
/// a browser-side fetch from the webview is blocked by CORS.
///
/// Primary source is the track embed page, whose `__NEXT_DATA__` payload
/// carries the artist list and cover art. The oEmbed endpoint is the
/// fallback: it returns only a combined "Title - Artist" string.
#[tauri::command]
pub async fn fetch_track_metadata(track_id: String) -> Result<Option<TrackMetadata>, String> {
    if let Some(metadata) = fetch_from_embed_page(&track_id).await {
        return Ok(Some(metadata));
    }
    fetch_from_oembed(&track_id).await
}

/// Fetches the embed page and reads its `__NEXT_DATA__` payload. Returns
/// `None` for any failure — network, status, or an unexpected JSON shape —
/// so the caller falls back to oEmbed.
async fn fetch_from_embed_page(track_id: &str) -> Option<TrackMetadata> {
    let url = format!("https://open.spotify.com/embed/track/{track_id}");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, DESKTOP_USER_AGENT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let html = response.text().await.ok()?;
    let payload = extract_next_data(&html)?;
    let root: Value = serde_json::from_str(payload).ok()?;
    let entity = root
        .pointer("/props/pageProps/state/data/entity")
        .unwrap_or(&Value::Null);

    metadata_from_entity(entity)
}

/// Slices the JSON body out of the `__NEXT_DATA__` script tag.
fn extract_next_data(html: &str) -> Option<&str> {
    let start = html.find(NEXT_DATA_OPEN)? + NEXT_DATA_OPEN.len();
    let rest = &html[start..];
    let end = rest.find(NEXT_DATA_CLOSE)?;
    Some(rest[..end].trim())
}

/// Reads title, artists and cover art off the embed page's track entity.
/// Returns `None` unless at least a non-empty title is present.
fn metadata_from_entity(entity: &Value) -> Option<TrackMetadata> {
    let title = entity
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| entity.get("title").and_then(Value::as_str))
        .map(str::trim)
        .filter(|title| !title.is_empty())?;

    let artist = entity
        .get("artists")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();

    Some(TrackMetadata {
        title: title.to_string(),
        artist,
        thumbnail_url: pick_cover_art(entity),
    })
}

/// Picks the highest-resolution cover art url. Spotify has shipped two
/// shapes for this list, so try both before giving up.
fn pick_cover_art(entity: &Value) -> Option<String> {
    let candidates = entity
        .pointer("/coverArt/sources")
        .and_then(Value::as_array)
        .or_else(|| {
            entity
                .pointer("/visualIdentity/image")
                .and_then(Value::as_array)
        })?;

    let widest = candidates
        .iter()
        .filter(|image| image.get("url").and_then(Value::as_str).is_some())
        .max_by_key(|image| image_width(image))?;

    widest
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn image_width(image: &Value) -> u64 {
    image
        .get("width")
        .or_else(|| image.get("maxWidth"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// Fallback lookup. oEmbed gives a single "Title - Artist" string, so the
/// split here is a guess — titles containing " - " lose their tail.
async fn fetch_from_oembed(track_id: &str) -> Result<Option<TrackMetadata>, String> {
    let url =
        format!("https://open.spotify.com/oembed?url=https://open.spotify.com/track/{track_id}");

    let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }

    let body: OembedResponse = response.json().await.map_err(|e| e.to_string())?;
    let Some(full_title) = body.title else {
        return Ok(None);
    };

    let (title, artist) = match full_title.rfind(" - ") {
        Some(index) => (
            full_title[..index].to_string(),
            full_title[index + 3..].to_string(),
        ),
        None => (full_title, String::new()),
    };

    Ok(Some(TrackMetadata {
        title,
        artist,
        thumbnail_url: body.thumbnail_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_script_payload() {
        let html = format!("<html><body>{NEXT_DATA_OPEN}{{\"a\":1}}{NEXT_DATA_CLOSE}</body>");
        assert_eq!(extract_next_data(&html), Some("{\"a\":1}"));
    }

    #[test]
    fn missing_script_tag_yields_none() {
        assert_eq!(extract_next_data("<html></html>"), None);
    }

    #[test]
    fn reads_name_artists_and_visual_identity_image() {
        let entity: Value = serde_json::from_str(
            r#"{
                "name": "Never Gonna Give You Up",
                "artists": [{ "name": "Rick Astley" }, { "name": "Someone" }],
                "visualIdentity": { "image": [
                    { "url": "small", "maxWidth": 64 },
                    { "url": "large", "maxWidth": 640 }
                ]}
            }"#,
        )
        .unwrap();

        let metadata = metadata_from_entity(&entity).unwrap();
        assert_eq!(metadata.title, "Never Gonna Give You Up");
        assert_eq!(metadata.artist, "Rick Astley, Someone");
        assert_eq!(metadata.thumbnail_url.as_deref(), Some("large"));
    }

    #[test]
    fn reads_cover_art_sources_shape() {
        let entity: Value = serde_json::from_str(
            r#"{
                "name": "Track",
                "coverArt": { "sources": [
                    { "url": "a", "width": 300 },
                    { "url": "b", "width": 640 }
                ]}
            }"#,
        )
        .unwrap();

        let metadata = metadata_from_entity(&entity).unwrap();
        assert_eq!(metadata.artist, "");
        assert_eq!(metadata.thumbnail_url.as_deref(), Some("b"));
    }

    #[test]
    fn unknown_shape_yields_none() {
        assert_eq!(metadata_from_entity(&Value::Null).is_none(), true);
        assert_eq!(
            metadata_from_entity(&serde_json::json!({ "name": "" })).is_none(),
            true
        );
    }
}
