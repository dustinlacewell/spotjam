import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  PlaylistFetchError,
  parseSpotifyAlbumLink,
  parseSpotifyArtistLink,
  parseSpotifyPlaylistLink,
  type ImportedPlaylist,
  type ListService,
  type MoveTarget,
  type ParsedTrack,
  type PlaylistRow,
  type PlaylistService,
  type StaticListTracks,
} from "@spotjam/room";

/**
 * What the Rust `spotify_fetch_playlist` command returns.
 *
 * Unlike `spotify_fetch_tracks`, this one is camelCase on the wire — so
 * `durationMs` arrives spelled as it is used, with no mapping.
 */
export interface FetchedPlaylist {
  name: string;
  canAdd?: boolean;
  canEditItems?: boolean;
  tracks: {
    uri: string;
    name: string;
    artist: string;
    uid?: string;
    /** Track length in ms. Absent or zero means the client did not say. */
    durationMs?: number;
  }[];
}

/** The tagged failure the Rust commands reject with. */
export interface FetchFailure {
  kind: "gone" | "unreachable";
  message: string;
}

export type { ImportedPlaylist };

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const TRACK_URI_PREFIX = "spotify:track:";

/** What the Rust `spotify_fetch_list` command returns. */
export interface FetchedStaticList {
  tracks: { uri: string }[];
}

/**
 * Fetches a Spotify playlist through the Rust side and reduces it to the rows
 * the local playlist store keeps. Entries that are not tracks (local files,
 * episodes) are dropped: we can only queue track URIs.
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
    // Absent reads as "cannot": offering a write Spotify will refuse is worse
    // than hiding one that would have worked.
    canAdd: fetched.canAdd === true,
    canEditItems: fetched.canEditItems === true,
    rows: toRows(fetched.tracks),
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
 * Removes rows from the Spotify playlist.
 *
 * A row with no uid was never synced, so Spotify has nothing to address; those
 * are dropped rather than sent as an empty id the client would reject.
 */
export async function removeRowsFromPlaylist(
  playlistId: string,
  rows: PlaylistRow[],
  invoke: Invoke = tauriInvoke,
): Promise<void> {
  const addressable = toRowRefs(rows);
  if (addressable.length === 0) return;
  try {
    await invoke<void>("spotify_remove_from_playlist", {
      uri: `spotify:playlist:${playlistId}`,
      rows: addressable,
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

/** Moves one row so it sits before or after another. */
export async function moveRowInPlaylist(
  playlistId: string,
  row: PlaylistRow,
  target: MoveTarget,
  invoke: Invoke = tauriInvoke,
): Promise<void> {
  const refs = toRowRefs([row]);
  if (refs.length === 0) return;
  try {
    await invoke<void>("spotify_move_in_playlist", {
      uri: `spotify:playlist:${playlistId}`,
      rows: refs,
      beforeUid: "beforeUid" in target ? target.beforeUid : null,
      afterUid: "afterUid" in target ? target.afterUid : null,
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

/** The Tauri-backed adapter the app hands to @spotjam/room. */
export const tauriPlaylistService: PlaylistService = {
  import: (uri) => importPlaylist(uri),
  addTracks: (playlistId, tracks) => addTracksToPlaylist(playlistId, tracks),
  removeRows: (playlistId, rows) => removeRowsFromPlaylist(playlistId, rows),
  moveRow: (playlistId, row, target) => moveRowInPlaylist(playlistId, row, target),
};

/**
 * Fetches the track list behind an album or artist link, through the Rust
 * side's list platform path. The tracks arrive as bare references — no names,
 * no durations — so this reduces them to the parsed shape the enqueue path
 * already resolves lengths for.
 *
 * Rejects with a `PlaylistFetchError` carrying Rust's verdict on why, with
 * the same failure semantics as the playlist fetch.
 */
export async function fetchStaticList(
  uri: string,
  invoke: Invoke = tauriInvoke,
): Promise<StaticListTracks> {
  const link = parseSpotifyAlbumLink(uri) ?? parseSpotifyArtistLink(uri);
  if (!link) {
    throw new PlaylistFetchError("unreachable", `Not a Spotify album or artist link: ${uri}`);
  }

  let fetched: FetchedStaticList;
  try {
    fetched = await invoke<FetchedStaticList>("spotify_fetch_list", { uri: link.uri });
  } catch (error) {
    throw toFetchError(error);
  }

  const tracks: ParsedTrack[] = [];
  for (const entry of fetched.tracks) {
    if (!entry.uri.startsWith(TRACK_URI_PREFIX)) continue;
    const trackId = entry.uri.slice(TRACK_URI_PREFIX.length);
    if (!trackId) continue;
    tracks.push({ uri: entry.uri, trackId });
  }
  return { tracks };
}

/** The Tauri-backed list adapter the app hands to @spotjam/room. */
export const tauriListService: ListService = {
  fetch: (uri) => fetchStaticList(uri),
};

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

function toRows(entries: FetchedPlaylist["tracks"]): PlaylistRow[] {
  const rows: PlaylistRow[] = [];
  for (const entry of entries) {
    if (!entry.uri.startsWith(TRACK_URI_PREFIX)) continue;
    const trackId = entry.uri.slice(TRACK_URI_PREFIX.length);
    if (!trackId) continue;
    rows.push({
      // Zero stands for "the client did not say". The enqueue path looks a
      // missing length up rather than sending a zero, which the server would
      // run out the instant it started.
      track: { uri: entry.uri, trackId, durationMs: durationOf(entry.durationMs) },
      ...(entry.uid ? { uid: entry.uid } : {}),
    });
  }
  return rows;
}

/** A usable length, or 0 for none. Guards a negative or non-numeric field. */
function durationOf(durationMs: number | undefined): number {
  return typeof durationMs === "number" && durationMs > 0 ? durationMs : 0;
}

function toRowRefs(rows: PlaylistRow[]): { uid: string; uri: string }[] {
  return rows
    .filter((row) => typeof row.uid === "string" && row.uid.length > 0)
    .map((row) => ({ uid: row.uid as string, uri: row.track.uri }));
}
