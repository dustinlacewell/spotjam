use super::cdp::CdpClient;
use super::registry::ensure_script;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use prost::Message;
use serde::Serialize;
use std::sync::LazyLock;

/// Sent to the webview as-is. Field names stay snake_case on the wire;
/// track-metadata.ts maps `thumbnail_url` to `thumbnailUrl` itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: String,
    pub thumbnail_url: Option<String>,
    /// Track length in milliseconds. 0 when the client's message carries no
    /// duration.
    pub duration_ms: u64,
}

/// The metadata extension kind for a `spotify.metadata.Track` (`TRACK_V4`).
const TRACK_V4: u32 = 10;

/// Keeps one metadata request a comfortable size.
const MAX_URIS_PER_CALL: usize = 50;

/// Stashes xpui's metadata extensions API, the object every list on screen
/// asks for track, album and artist data. See
/// docs/desktop/spotify-bridge/track-metadata.md.
static ENSURE_METADATA_API_JS: LazyLock<String> = LazyLock::new(|| {
    ensure_script(
        "__metadataApi",
        r#"(() => {
    const api = resolveService("PlaylistAPI")._metadataExtensionsAPI;
    if (!api || typeof api.fetch !== "function") throw new Error("PlaylistAPI has no _metadataExtensionsAPI");
    return api;
  })()"#,
    )
});

async fn ensure_metadata_api(cdp: &CdpClient) -> Result<()> {
    cdp.evaluate(&ENSURE_METADATA_API_JS).await?;
    Ok(())
}

/// Looks up display metadata for several tracks through the client's own
/// metadata service. One entry per id, in order; `None` where the client
/// knows no such track.
pub async fn fetch_tracks(cdp: &CdpClient, track_ids: Vec<String>) -> Result<Vec<Option<TrackMetadata>>> {
    ensure_metadata_api(cdp).await?;
    let mut out = Vec::with_capacity(track_ids.len());
    for chunk in track_ids.chunks(MAX_URIS_PER_CALL) {
        out.extend(fetch_chunk(cdp, chunk).await?);
    }
    Ok(out)
}

/// Asks for `TRACK_V4` on each URI and returns the raw message bytes,
/// base64-encoded, in input order. `null` where the client returned no entry.
async fn fetch_chunk(cdp: &CdpClient, track_ids: &[String]) -> Result<Vec<Option<TrackMetadata>>> {
    let uris: Vec<String> = track_ids.iter().map(|id| format!("spotify:track:{id}")).collect();
    let uris_json = serde_json::to_string(&uris)?;
    let expr = format!(
        r#"(async () => {{
            const uris = {uris_json};
            const results = await window.__metadataApi.fetch(...uris.map((uri) => [uri, {TRACK_V4}]));
            return JSON.stringify(uris.map((uri) => {{
                const bytes = results?.[uri]?.["{TRACK_V4}"]?.value;
                if (!bytes) return null;
                return btoa(String.fromCharCode(...Object.values(bytes)));
            }}));
        }})()"#
    );
    let value = cdp.evaluate(&expr).await?;
    let json_str = value
        .as_str()
        .ok_or_else(|| anyhow!("metadata fetch did not return a JSON string: {value}"))?;
    let encoded: Vec<Option<String>> = serde_json::from_str(json_str)?;
    encoded
        .iter()
        .map(|entry| entry.as_deref().map(decode_track).transpose())
        .collect()
}

/// Decodes a base64 `spotify.metadata.Track` into display metadata.
fn decode_track(encoded: &str) -> Result<TrackMetadata> {
    let bytes = BASE64.decode(encoded)?;
    let track = proto::Track::decode(bytes.as_slice())?;
    Ok(metadata_from_track(&track))
}

/// Reads title, artists and the widest cover image off a decoded track.
fn metadata_from_track(track: &proto::Track) -> TrackMetadata {
    let artist = track
        .artist
        .iter()
        .filter_map(|artist| artist.name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(", ");

    TrackMetadata {
        title: track.name.as_deref().unwrap_or_default().trim().to_string(),
        artist,
        thumbnail_url: widest_cover(track),
        duration_ms: track.duration.unwrap_or(0).max(0) as u64,
    }
}

fn widest_cover(track: &proto::Track) -> Option<String> {
    track
        .album
        .as_ref()?
        .cover_group
        .as_ref()?
        .image
        .iter()
        .max_by_key(|image| image.width.unwrap_or(0))
        .map(|image| format!("https://i.scdn.co/image/{}", hex(&image.file_id)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The slice of `spotify.metadata` the app reads. prost skips every field
/// not declared here.
mod proto {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Track {
        #[prost(string, optional, tag = "2")]
        pub name: Option<String>,
        #[prost(message, optional, tag = "3")]
        pub album: Option<Album>,
        #[prost(message, repeated, tag = "4")]
        pub artist: Vec<Artist>,
        /// Milliseconds. Plain `int32` in spotify.metadata, not zigzag.
        #[prost(int32, optional, tag = "7")]
        pub duration: Option<i32>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Album {
        #[prost(string, optional, tag = "2")]
        pub name: Option<String>,
        #[prost(message, optional, tag = "17")]
        pub cover_group: Option<ImageGroup>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Artist {
        #[prost(string, optional, tag = "2")]
        pub name: Option<String>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ImageGroup {
        #[prost(message, repeated, tag = "1")]
        pub image: Vec<Image>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Image {
        #[prost(bytes = "vec", tag = "1")]
        pub file_id: Vec<u8>,
        #[prost(sint32, optional, tag = "3")]
        pub width: Option<i32>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `spotify:track:582gpRUX6LEVXbuCdgIDaq` as the client returned it.
    const CYBERBIRD: &str = "ChCoixEwFzVLFKxvXxBSibWiEhXjgrXjgqTjg5Djg7zjg5Djg7zjg4ka7wEKENXFoXI2iEBehYqEVFoyUqgSLeaUu+auu+apn+WLlemaiiBTVEFORCBBTE9ORSBDT01QTEVY44CATy5TLlQuMhoeChALOzYPgTJJlbeUAuzAyTPyEgpZb2tvIEthbm5vIAEqCUZseWluZ0RvZzIHCLYfEAYYPIoBYAoeChSrZ2FtAAAeAs/9PXstOD6TkesvGBAAGNgEINgECh4KFKtnYW0AAEhRz/09ey04PpOR6y8YEAEYgAEggAEKHgoUq2dhbQAAsnPP/T17LTg+k5HrLxgQAhiACiCACsoBEgoQ4gIem406QSS9/IOTb8swmiIiChA5gaKBFvxCb4dGW8ZHQ+XgEg5HYWJyaWVsYSBSb2JpbigCMAI40uYrQFhSFAoEaXNyYxIMSlBWSTAwNDE4NDEwYhgKFCk6dNARRVdY64giboYsbGTpjs3FEAJiGAoUD80Q9tENbcPPsx5WvTpoE2I9NFIQAWIYChSJ9IVhj+Q99avYVXCW2S6EiLAe9BAAYhgKFE48OzWz1aHnpJA1F0yniSSi5l0rEAh6GAoUbHx18MVVumqLSxnECZ4kMwx0VgIQBogBsKXv6gWQAQGqARIKEOICHpuNOkEkvfyDk2/LMJqyAQJlbsIBFAoQUFBBuMFMT8unTOxABRikNBAB2gEV44K144Kk44OQ44O844OQ44O844OJggIkChA5gaKBFvxCb4dGW8ZHQ+XgEg5HYWJyaWVsYSBSb2JpbhgBogIkc3BvdGlmeTp0cmFjazo1ODJncFJVWDZMRVZYYnVDZGdJRGFxugIuCiwYA1IoCiRlMjAyMWU5Yi04ZDNhLTQxMjQtYmRmYy04MzkzNmZjYjMwOWEQA8oCFgoUChBQUEG4wUxPy6dM7EAFGKQ0EAHYAgDiAg4SDAiLvJ7qBRDA7+u9Aw==";

    #[test]
    fn decodes_a_real_track_message() {
        let metadata = decode_track(CYBERBIRD).unwrap();
        assert_eq!(metadata.title, "サイバーバード");
        assert_eq!(metadata.artist, "Gabriela Robin");
        assert_eq!(
            metadata.thumbnail_url.as_deref(),
            Some("https://i.scdn.co/image/ab67616d0000b273cffd3d7b2d383e9391eb2f18")
        );
        assert_eq!(metadata.duration_ms, 717_650);
    }

    #[test]
    fn picks_the_widest_cover() {
        let track = proto::Track {
            name: Some("Track".into()),
            album: Some(proto::Album {
                name: None,
                cover_group: Some(proto::ImageGroup {
                    image: vec![
                        proto::Image { file_id: vec![0xaa], width: Some(64) },
                        proto::Image { file_id: vec![0xbb], width: Some(640) },
                        proto::Image { file_id: vec![0xcc], width: Some(300) },
                    ],
                }),
            }),
            artist: vec![],
            duration: None,
        };
        assert_eq!(
            metadata_from_track(&track).thumbnail_url.as_deref(),
            Some("https://i.scdn.co/image/bb")
        );
    }

    #[test]
    fn joins_artists_and_tolerates_missing_album() {
        let track = proto::Track {
            name: Some(" Track ".into()),
            album: None,
            artist: vec![
                proto::Artist { name: Some("A".into()) },
                proto::Artist { name: Some("".into()) },
                proto::Artist { name: Some("B".into()) },
            ],
            duration: None,
        };
        let metadata = metadata_from_track(&track);
        assert_eq!(metadata.title, "Track");
        assert_eq!(metadata.artist, "A, B");
        assert_eq!(metadata.thumbnail_url, None);
    }

    /// Tag 7 is a plain `int32`, so a negative or absent value must not wrap
    /// into an enormous u64.
    #[test]
    fn reads_the_duration_and_floors_it_at_zero() {
        let with = proto::Track {
            name: None,
            album: None,
            artist: vec![],
            duration: Some(214_000),
        };
        assert_eq!(metadata_from_track(&with).duration_ms, 214_000);

        let negative = proto::Track { duration: Some(-1), ..with.clone() };
        assert_eq!(metadata_from_track(&negative).duration_ms, 0);

        let absent = proto::Track { duration: None, ..with };
        assert_eq!(metadata_from_track(&absent).duration_ms, 0);
    }

    #[test]
    fn garbage_fails_to_decode() {
        assert!(decode_track("not base64!").is_err());
    }
}
