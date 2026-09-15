// The playlist service port — how the app layer reads a playlist in from
// outside, and writes to it. The desktop app goes through Rust to the
// signed-in Spotify client; the shapes here are the only thing the app layer
// knows about.

import type { PlaylistRow } from "../lib/playlists";
import type { ParsedTrack } from "../lib/spotify-link";

/**
 * A playlist as it arrives from outside: a name, its rows, the Spotify id it
 * came from — kept so the playlist can stay linked and be synced again — and
 * what Spotify will let us do to it.
 */
export interface ImportedPlaylist {
  playlistId: string;
  name: string;
  rows: PlaylistRow[];
  /**
   * False for a playlist someone else owns. A link can point at anyone's
   * playlist, and only its owner may write to one.
   */
  canAdd: boolean;
  /** Whether rows may be removed or reordered. Tracked apart from `canAdd`. */
  canEditItems: boolean;
}

/**
 * Why a read or a write did not succeed.
 *
 * The split is the whole point of this type. "gone" means Spotify answered and
 * said no such playlist: the content is really gone, so a linked playlist that
 * gets this may be dropped. "unreachable" means we never got an answer — the
 * client is closed, the connection broke, the call hung. A linked playlist
 * that gets this must be left exactly as it is.
 *
 * Anything ambiguous is "unreachable". Guessing wrong in that direction costs
 * a retry; guessing wrong the other way deletes someone's playlist.
 */
export type PlaylistFetchFailure = "gone" | "unreachable";

export class PlaylistFetchError extends Error {
  readonly reason: PlaylistFetchFailure;

  constructor(reason: PlaylistFetchFailure, message: string) {
    super(message);
    this.name = "PlaylistFetchError";
    this.reason = reason;
  }
}

/** True when this failure means the playlist no longer exists in Spotify. */
export function isGone(error: unknown): boolean {
  return error instanceof PlaylistFetchError && error.reason === "gone";
}

/**
 * Where a moved row should land.
 *
 * Spotify has no "end" spec for a move, so landing last means naming the row
 * to sit after. The caller resolves which of the two it wants from the rows it
 * is holding.
 */
export type MoveTarget = { beforeUid: string } | { afterUid: string };

export interface PlaylistService {
  /** Rejects with a `PlaylistFetchError` when the fetch fails. */
  import(uri: string): Promise<ImportedPlaylist>;
  /** Appends tracks to the Spotify playlist itself. */
  addTracks(playlistId: string, tracks: ParsedTrack[]): Promise<void>;
  /** Removes rows, addressed by their Spotify uids. */
  removeRows(playlistId: string, rows: PlaylistRow[]): Promise<void>;
  /** Moves one row to sit before or after another. */
  moveRow(playlistId: string, row: PlaylistRow, target: MoveTarget): Promise<void>;
}
