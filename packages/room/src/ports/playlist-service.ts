// The playlist service port — how the app layer reads a playlist in from
// outside, and writes tracks back to it. The desktop app goes through Rust to
// the signed-in Spotify client; the shapes here are the only thing the app
// layer knows about.

import type { ParsedTrack } from "../lib/spotify-link";

/**
 * A playlist as it arrives from outside: a name, the tracks we can queue, the
 * Spotify id it came from — kept so the playlist can stay linked and be synced
 * again — and whether we are allowed to add tracks to it.
 */
export interface ImportedPlaylist {
  playlistId: string;
  name: string;
  tracks: ParsedTrack[];
  /**
   * False for a playlist someone else owns. A link can point at anyone's
   * playlist, and only its owner may write to it.
   */
  canAdd: boolean;
}

/**
 * Why a fetch or a write did not succeed.
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

export interface PlaylistService {
  /** Rejects with a `PlaylistFetchError` when the fetch fails. */
  import(uri: string): Promise<ImportedPlaylist>;
  /**
   * Appends tracks to the Spotify playlist itself. Rejects with a
   * `PlaylistFetchError` when the write fails.
   */
  addTracks(playlistId: string, tracks: ParsedTrack[]): Promise<void>;
}
