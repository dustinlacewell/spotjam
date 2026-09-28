// The static list service port — how the app layer resolves an album or
// artist link into the track list it stands for. The desktop app goes through
// Rust to the signed-in Spotify client; the shape here is the only thing the
// app layer knows about.

import type { ParsedTrack } from "../lib/spotify-link";

/**
 * A link that resolves to a static track list, as it arrives from outside.
 *
 * The rows carry no durations — the client serves bare `spotify:track:`
 * references — so the enqueue path resolves durations the same way it does
 * for track links.
 */
export interface StaticList {
  /** The album or artist name. Null when the lookup failed. */
  name: string | null;
  tracks: ParsedTrack[];
}

export interface ListService {
  /**
   * Fetches the track list behind an album or artist URI. Rejects with the
   * playlist fetch's `PlaylistFetchError` (`ports/playlist-service`): the
   * failure semantics are shared — `gone` means Spotify answered and the link
   * no longer resolves, and every other failure is `unreachable`.
   */
  fetch(uri: string): Promise<StaticList>;
}