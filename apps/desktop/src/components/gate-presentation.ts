// What the Spotify gate shows for one bridge state.
//
// Pure, so the one property that matters can be tested without a bridge or a
// renderer: no state ever leaves the user with a spinner and nothing to press.
//
// The bridge has two kinds of down. Some states Rust works its way out of on
// its own — it is polling, or spawning Spotify, and the answer arrives without
// the user. Others only the user can fix. Spinner-versus-button follows that
// split, with one correction: "self-resolving" is a claim about what Rust is
// trying, not a guarantee that it will succeed, and two of its states can sit
// still forever.
//
//   - `booting` means the debug port answered but no xpui page is listed. A
//     Spotify parked on its login screen is exactly that, and it stays that way
//     until somebody signs in. Rust re-probes and re-probes; the state never
//     moves.
//   - `no-spotify` means we asked Spotify to start. When the spawn silently did
//     nothing — wrong install path, a launch the OS refused — nothing moves
//     either.
//
// So a wait that has gone on long enough to be one of those cases stops being
// a spinner and becomes a button with an explanation. Waiting is still the
// first answer, because the ordinary case really does resolve in a few seconds.

import type { BridgeState } from "../lib/bridge-state";

/**
 * How long the gate has been showing this state: `fresh` while the ordinary
 * case still has time to land, `waited` once it plainly has not.
 */
export type GatePhase = "fresh" | "waited";

/**
 * How long a self-resolving state may spin before the gate assumes it is one of
 * the cases that never resolves. Rust's own poll gives up at 30 s and reports
 * `booting`, so this sits past that: a gate that turned actionable earlier would
 * be second-guessing a poll that is still running.
 */
export const PATIENCE_MS = 35_000;

/** The states only the user can fix. They get the button from the first render. */
export const NEVER_SELF_RESOLVES: readonly BridgeState[] = ["no-debug-port", "lost"];

export interface GateView {
  /** Why the room is blocked, in one line. */
  reason: string;
  /** The fix, when there is one the user performs outside the app. */
  hint: string | null;
  /** Show the spinner. */
  spinner: boolean;
  /** Offer the Sync button. */
  canSync: boolean;
  /** What to say when a Sync press answered with this state instead of `ready`. */
  afterAttempt: string | null;
}

const DEBUG_PORT_HINT = "Spotify must be started with --remote-debugging-port=9222";

/**
 * What the gate shows for `state`, given how long it has been showing it.
 *
 * `ready` never reaches here — the gate is not rendered at all then — but it is
 * handled rather than excluded so a caller cannot produce an empty panel.
 */
export function gatePresentation(state: BridgeState, phase: GatePhase): GateView {
  const waited = phase === "waited";

  switch (state) {
    case "ready":
      return {
        reason: "Spotify is connected.",
        hint: null,
        spinner: false,
        canSync: false,
        afterAttempt: null,
      };

    case "no-debug-port":
      return {
        reason: "Spotify is running without the debugging flag.",
        hint: DEBUG_PORT_HINT,
        spinner: false,
        canSync: true,
        afterAttempt: "Spotify is still running without the debugging flag. Restart it, then sync.",
      };

    case "lost":
      return {
        reason: "The connection to Spotify was lost.",
        hint: null,
        spinner: false,
        canSync: true,
        afterAttempt: "Still not connected. Check that Spotify is running.",
      };

    // The port answered and no xpui page appeared. For a few seconds that is an
    // app still coming up. Past that it is almost always a client sitting on its
    // login screen, which spotjam cannot get past and cannot see into: the login
    // window is a different page, so all we know is that xpui is not there.
    case "booting":
      return waited
        ? {
            reason: "Spotify is open but not signed in, or still starting.",
            hint: null,
            spinner: false,
            canSync: true,
            afterAttempt: "Spotify is still not ready. Sign in to Spotify, then sync.",
          }
        : {
            reason: "Spotify is starting.",
            hint: null,
            spinner: true,
            canSync: false,
            afterAttempt: null,
          };

    // We asked Spotify to start. It normally appears within seconds; when it
    // does not, the launch did not work and only the user can start it.
    case "no-spotify":
      return waited
        ? {
            reason: "Spotify did not start.",
            hint: null,
            spinner: false,
            canSync: true,
            afterAttempt: "Still no Spotify. Start Spotify yourself, then sync.",
          }
        : {
            reason: "Starting Spotify.",
            hint: null,
            spinner: true,
            canSync: false,
            afterAttempt: null,
          };
  }
}
