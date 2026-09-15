import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  PlaylistFetchError,
  parseSpotifyPlaylistLink,
  type ImportedPlaylist,
  type ParsedTrack,
  type PlaylistService,
} from "@spotjam/room";

/** What the Rust `spotify_fetch_playlist` command returns. */
export interface FetchedPlaylist {
  name: string;
  canAdd?: boolean;
  tracks: { uri: string; name: string; artist: string }[];
}

/** The tagged failure the Rust command rejects with. */
export interface FetchFailure {
  kind: "gone" | "unreachable";
  message: string;
}

export type { ImportedPlaylist };

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const TRACK_URI_PREFIX = "spotify:track:";

/**
 * Fetches a Spotify playlist through the Rust side and reduces it to the
 * track shape the local playlist store keeps. Entries that are not tracks
 * (local files, episodes) are dropped: we can only queue track URIs.
 *
 * Rejects with a `PlaylistFetchError` carrying Rust's verdict on why: only a
 * `gone` may drop a linked playlist.
 */
export async function importPlaylist(
  uri: string,
  invoke: Invoke = tauriInvoke,
): Promise<ImportedPlaylist> {
  const playlistId = parseSpotifyPlaylistLink(uri)?.playlistId;
  if (!playlistId) {
    throw new PlaylistFetchError("unreachable", `Not a Spotify playlist link: ${uri}`);
  }

  let fetched: FetchedPlaylist;
  try {
    fetched = await invoke<FetchedPlaylist>("spotify_fetch_playlist", { uri });
  } catch (error) {
    throw toFetchError(error);
  }

  return {
    playlistId,
    name: fetched.name,
    // Absent reads as "cannot add": offering a write Spotify will refuse is
    // worse than hiding one that would have worked.
    canAdd: fetched.canAdd === true,
    tracks: toParsedTracks(fetched.tracks),
  };
}

/**
 * Appends tracks to the Spotify playlist itself, through the Rust side.
 *
 * Spotify owns a linked playlist's content, so this is where an add has to
 * land — a local insert would only survive until the next sync.
 */
export async function addTracksToPlaylist(
  playlistId: string,
  tracks: ParsedTrack[],
  invoke: Invoke = tauriInvoke,
): Promise<void> {
  if (tracks.length === 0) return;
  try {
    await invoke<void>("spotify_add_to_playlist", {
      uri: `spotify:playlist:${playlistId}`,
      trackUris: tracks.map((track) => track.uri),
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

/**
 * Reads Rust's tagged failure back into a typed error.
 *
 * A rejection that does not carry the tag never becomes "gone". Anything
 * unrecognised is treated as a client we could not reach, which is the
 * failure direction that leaves the user's playlists alone.
 */
function toFetchError(error: unknown): PlaylistFetchError {
  const failure = error as Partial<FetchFailure> | null;
  if (failure?.kind === "gone") {
    return new PlaylistFetchError("gone", failure.message ?? "That playlist no longer exists.");
  }
  if (failure?.kind === "unreachable") {
    return new PlaylistFetchError("unreachable", failure.message ?? "Can't connect to Spotify.");
  }
  return new PlaylistFetchError("unreachable", messageOf(error));
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The Tauri-backed adapter the app hands to @spotjam/room. */
export const tauriPlaylistService: PlaylistService = {
  import: (uri) => importPlaylist(uri),
  addTracks: (playlistId, tracks) => addTracksToPlaylist(playlistId, tracks),
};

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
