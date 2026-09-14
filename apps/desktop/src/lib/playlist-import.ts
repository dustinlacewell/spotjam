import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ParsedTrack } from "./spotify-link";

/** What the Rust `spotify_fetch_playlist` command returns. */
export interface FetchedPlaylist {
  name: string;
  tracks: { uri: string; name: string; artist: string }[];
}

export interface ImportedPlaylist {
  name: string;
  tracks: ParsedTrack[];
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const TRACK_URI_PREFIX = "spotify:track:";

/**
 * Fetches a Spotify playlist through the Rust side and reduces it to the
 * track shape the local playlist store keeps. Entries that are not tracks
 * (local files, episodes) are dropped: we can only queue track URIs.
 */
export async function importPlaylist(
  uri: string,
  invoke: Invoke = tauriInvoke,
): Promise<ImportedPlaylist> {
  const fetched = await invoke<FetchedPlaylist>("spotify_fetch_playlist", { uri });
  return { name: fetched.name, tracks: toParsedTracks(fetched.tracks) };
}

function toParsedTracks(entries: FetchedPlaylist["tracks"]): ParsedTrack[] {
  const tracks: ParsedTrack[] = [];
  for (const entry of entries) {
    if (!entry.uri.startsWith(TRACK_URI_PREFIX)) continue;
    const trackId = entry.uri.slice(TRACK_URI_PREFIX.length);
    if (!trackId) continue;
    tracks.push({ uri: entry.uri, trackId });
  }
  return tracks;
}
