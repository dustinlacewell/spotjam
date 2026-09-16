// observation — one reading of the local Spotify client.
//
// The bridge answers `spotify_observe` with the player's state and the head of
// Spotify's own one-slot queue. This is that answer, flattened, plus the local
// instant it was taken at. Everything downstream compares observations; nothing
// downstream asks Spotify anything else.

/** What Spotify was doing at one instant. `at` is a local clock, not the server's. */
export interface Observation {
  trackUri: string | null;
  isPaused: boolean;
  positionMs: number;
  durationMs: number;
  queueHead: string | null;
  at: number;
}

/** What the bridge sends back for `spotify_observe`. */
export interface ObserveResult {
  state: {
    trackUri: string | null;
    trackName: string | null;
    isPaused: boolean;
    positionMs: number;
    durationMs: number;
  };
  queueHead: string | null;
}

/**
 * An advert is not a track anyone chose, and Spotify plays one whenever it
 * likes. Every rule that reads a track change as the user acting has to let
 * these through, or a free account detaches the driver on its own.
 */
export function isAd(uri: string | null): boolean {
  return uri !== null && uri.startsWith("spotify:ad:");
}

/** The bridge's answer as an observation, stamped with the local clock. */
export function observationFrom(result: ObserveResult, at: number): Observation {
  return {
    trackUri: result.state.trackUri,
    isPaused: result.state.isPaused,
    positionMs: result.state.positionMs,
    durationMs: result.state.durationMs,
    queueHead: result.queueHead,
    at,
  };
}
