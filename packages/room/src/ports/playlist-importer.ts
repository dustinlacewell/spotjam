// The playlist importer port — how the app layer pulls a playlist in from
// outside. The desktop app fetches it through Rust; the shape it returns is
// the only thing the app layer knows about.

import type { ParsedTrack } from "../lib/spotify-link";

/**
 * A playlist as it arrives from outside: a name, the tracks we can queue, and
 * the Spotify id it came from — kept so the playlist can stay linked to its
 * source and be synced again later.
 */
export interface ImportedPlaylist {
  playlistId: string;
  name: string;
  tracks: ParsedTrack[];
}

/**
 * Why a fetch did not produce a playlist.
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

export interface PlaylistImporter {
  /** Rejects with a `PlaylistFetchError` when the fetch fails. */
  import(uri: string): Promise<ImportedPlaylist>;
}
