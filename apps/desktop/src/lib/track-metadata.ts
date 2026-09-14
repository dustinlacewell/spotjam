import { invoke } from "@tauri-apps/api/core";

export interface TrackMetadata {
  title: string;
  artist: string;
  thumbnailUrl: string | null;
}

interface RustTrackMetadata {
  title: string;
  artist: string;
  thumbnail_url: string | null;
}

const cache = new Map<string, Promise<TrackMetadata | null>>();

/**
 * Looks up display metadata for a Spotify track. Runs through the Rust
 * backend (see track_metadata.rs) because open.spotify.com/oembed sends
 * no Access-Control-Allow-Origin header, so a webview-side fetch is
 * blocked by CORS.
 */
export function getTrackMetadata(trackUri: string): Promise<TrackMetadata | null> {
  const existing = cache.get(trackUri);
  if (existing) return existing;

  const trackId = trackUri.replace("spotify:track:", "");
  const promise = invoke<RustTrackMetadata | null>("fetch_track_metadata", { trackId })
    .then((data) =>
      data
        ? { title: data.title, artist: data.artist, thumbnailUrl: data.thumbnail_url }
        : null,
    )
    .catch(() => null);

  cache.set(trackUri, promise);
  return promise;
}
