use super::cdp::CdpClient;
use super::track_api::ensure_metadata_api;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use prost::Message;

/// The metadata extension kind for a `spotify.metadata.Artist` (`ARTIST_V4`).
const ARTIST_V4: u32 = 8;

/// The metadata extension kind for a `spotify.metadata.Album` (`ALBUM_V4`).
const ALBUM_V4: u32 = 9;

/// Looks up the name of an album or artist through the client's metadata
/// service — the same one the track lookup uses. `None` when the client
/// returned no entry or the entry carries no name.
///
/// `list_uri` must already be a normalised `spotify:album:` or
/// `spotify:artist:` URI.
pub async fn fetch_list_name(cdp: &CdpClient, list_uri: &str) -> Result<Option<String>> {
    let kind = extension_kind(list_uri).ok_or_else(|| anyhow!("not an album or artist URI: {list_uri}"))?;
    ensure_metadata_api(cdp).await?;

    let uri_json = serde_json::to_string(list_uri)?;
    let expr = format!(
        r#"(async () => {{
            const uri = {uri_json};
            const results = await window.__metadataApi.fetch([uri, {kind}]);
            const bytes = results?.[uri]?.["{kind}"]?.value;
            if (!bytes) return null;
            return btoa(String.fromCharCode(...Object.values(bytes)));
        }})()"#
    );
    match cdp.evaluate(&expr).await?.as_str() {
        Some(encoded) => decode_name(encoded),
        None => Ok(None),
    }
}

/// The extension kind that describes the list a URI names.
fn extension_kind(list_uri: &str) -> Option<u32> {
    if list_uri.starts_with("spotify:album:") {
        Some(ALBUM_V4)
    } else if list_uri.starts_with("spotify:artist:") {
        Some(ARTIST_V4)
    } else {
        None
    }
}

/// Reads the name off a base64 album or artist message. Both carry it at
/// tag 2.
fn decode_name(encoded: &str) -> Result<Option<String>> {
    let bytes = BASE64.decode(encoded)?;
    let named = proto::Named::decode(bytes.as_slice())?;
    Ok(named
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty()))
}

/// The slice of `spotify.metadata.Album` and `spotify.metadata.Artist` the
/// app reads. prost skips every field not declared here.
mod proto {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Named {
        #[prost(string, optional, tag = "2")]
        pub name: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `spotify:album:1S23RKAbHcn3AF2F7ns3sN` as the client returned it for
    /// `ALBUM_V4`.
    const ERA_EXTRANA: &str = "ChA9feMEtTBAFpDe8cB2fun1EgxFcmEgRXh0cmHDsWEaHwoQGKuRs42BQ/C6Ee4gu0qbfxILTmVvbiBJbmRpYW4gASoHTW9tK1BvcDIHCLYfEBIYGjgAUhQKA3VwYxINMDg4NjQ0MzE0NTI3NlryAQgCGhIKEMmswAR4tUV0uETp0rSBh0oaEgoQrMv5wH7hTL+2pdY8OE/6fBoSChCwIjtfqXpELqBcQT9pl3p/GhIKEESbDy+s5UMymz0CjpTvM6saEgoQCd14qIKYT26Kawg2EmFRfRoSChCxvU5kINtPm7sQdP2ZNBN8GhIKEMuMsm2uDE+bs7rbsZY0JVwaEgoQmwhizq7NQMKb2q5WenNE7xoSChAAA5U9dTlKZp7dE1iUDHzBGhIKENYuRtMVD0XVj09PIEjwcEEaEgoQW+OWl9S4Sg+sCXl6IwJAiRoSChDQZLxBc09NBIGUz9erJ/YUahAIARIMMjAxMSBNb20rUG9wahAIABIMMjAxMSBNb20rUG9wcgISAIoBYAoeChSrZ2FtAAAeAt7HZ+gCiCJy21WY/RAAGNgEINgECh4KFKtnYW0AAEhR3sdn6AKIInLbVZj9EAEYgAEggAEKHgoUq2dhbQAAsnPex2foAogicttVmP0QAhiACiCACpIBDEVyYSBFeHRyYcOxYbAB4sfR0QXKARIKEJ1e4IDOREbEjB9VLWNSeYiaAiRzcG90aWZ5OmFsYnVtOjNyajZhdGRSV1ozdnllWlJPeGJvZ0KiAiEKEBirkbONgUPwuhHuILtKm38SC05lb24gSW5kaWFuGAHKAi4KLBgEUigKJDlkNWVlMDgwLWNlNDQtNDZjNC04YzFmLTU1MmQ2MzUyNzk4OBAE6AIA";

    #[test]
    fn decodes_a_real_album_message() {
        assert_eq!(decode_name(ERA_EXTRANA).unwrap().as_deref(), Some("Era Extraña"));
    }

    #[test]
    fn a_message_without_a_name_has_none() {
        let encoded = BASE64.encode(proto::Named { name: Some("  ".into()) }.encode_to_vec());
        assert_eq!(decode_name(&encoded).unwrap(), None);
    }

    #[test]
    fn picks_the_extension_kind_from_the_uri() {
        assert_eq!(extension_kind("spotify:album:1S23RKAbHcn3AF2F7ns3sN"), Some(ALBUM_V4));
        assert_eq!(extension_kind("spotify:artist:0KydPQPUUoTNhmiHKOg5Er"), Some(ARTIST_V4));
        assert_eq!(extension_kind("spotify:track:68yp5LzDFF5aY2VOODJOQy"), None);
    }
}
