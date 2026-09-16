// classify — did the user touch the player, or did we?
//
// The driver commands Spotify and predicts what Spotify does on its own. A
// change that is neither commanded nor predicted is a person at the keyboard,
// and the driver lets go of the player rather than fighting them for it.
//
// The rule, one clause per thing that can change between two readings:
//
//   - trackUri changed. Explained if: something outstanding predicted this very
//     track — our own play of it, or the rollover registered as the last track
//     ran out; or obs.trackUri or prev.trackUri is an ad; or the previous
//     reading had already reached the end of its track.
//   - isPaused changed. Explained if: a pause/resume expectation is
//     outstanding, or a play for THIS track; or the track also changed and that
//     change was explained; or ad; or the player actually parked at the end of
//     the track (obs.positionMs >= obs.durationMs - 1500) — note this asks
//     about obs, not about prev.
//   - position jumped: if !prev.isPaused expected = prev.positionMs + (obs.at -
//     prev.at) else prev.positionMs; unexplained if |obs.positionMs - expected|
//     > 2000 and no seek that would accept this position is outstanding, and no
//     play for this track, and the track did not change. (A stall — obs behind
//     expected by up to the tick — never trips this; only a jump does.)
//
// Two of those clauses are narrower than they look, and both narrowings are
// load-bearing:
//
//   - "a play is outstanding" is not enough to excuse a track change. The user
//     picking their own track while our play of a different one is in flight
//     would be waved through, and the next tick would re-issue our play over
//     the top of them. Only an expectation naming the track we are actually
//     looking at explains it.
//   - the pause clause asks whether the player PARKED at the end, not whether
//     the track had run out. Spotify leaving a track that was about to end is
//     ordinary, but a pause in that last second is a person, and excusing it
//     means resuming over them on the next tick.
//
// The end of a track needs no clock arithmetic here. The driver registers a
// rollover as the track approaches its end, and that expectation is what
// explains the move — the gapless step into the queued next, autoplay after an
// empty queue, and a stop at the end alike. A reading delayed across the
// boundary is covered for the same reason: the rollover was registered before
// the stall and is still outstanding when the late reading lands.
//
// Pure. `prev === null` means there is nothing to compare, so nothing to blame.

import type { Expectation } from "./expectations.js";
import { holds, pending } from "./expectations.js";
import { isAd, type Observation } from "./observation.js";

/** How close to its own length a track must be to count as being at the end. */
const RAN_OUT_SLACK_MS = 1500;
/** How far a position may move unpredicted before it reads as a seek. */
const JUMP_SLACK_MS = 2000;

export type Verdict = "ok" | "user";

export function classify(
  prev: Observation | null,
  obs: Observation,
  outstanding: Expectation[],
): Verdict {
  if (prev === null) return "ok";

  const involvesAd = isAd(prev.trackUri) || isAd(obs.trackUri);
  const trackChanged = obs.trackUri !== prev.trackUri;
  const playingThis = playPendingFor(outstanding, obs.trackUri);
  // Something we are waiting on names this track: our play of it, or the
  // rollover that was registered as the last one ran out.
  const predicted = playingThis || rolloverLanded(outstanding, obs);

  const trackExplained = !trackChanged || predicted || involvesAd || parkedAtTheEnd(prev);
  if (!trackExplained) return "user";

  if (obs.isPaused !== prev.isPaused) {
    const pauseExplained =
      pending(outstanding, "pause") ||
      pending(outstanding, "resume") ||
      playingThis ||
      trackChanged ||
      involvesAd ||
      parkedAtTheEnd(obs);
    if (!pauseExplained) return "user";
  }

  if (!trackChanged && jumped(prev, obs, outstanding)) return "user";

  return "ok";
}

/** Is a play of exactly this track in flight? */
function playPendingFor(outstanding: Expectation[], uri: string | null): boolean {
  return outstanding.some((e) => e.what.kind === "play" && e.what.uri === uri);
}

/**
 * Is this reading the transition a rollover was waiting for?
 *
 * The driver registers one as a track nears its end, so the move Spotify makes
 * on its own is predicted before it happens — the gapless step into the queued
 * track, autoplay when the queue was empty, or simply leaving the track. This
 * asks the expectation itself whether what it predicted is what we are looking
 * at, which is the same question `prune` asks a moment later.
 */
function rolloverLanded(outstanding: Expectation[], obs: Observation): boolean {
  return outstanding.some((e) => e.what.kind === "rollover" && holds(e, obs));
}

/**
 * Is this reading sitting on the last moment of the track it names?
 *
 * Asked of `obs` by the pause clause: a player that parked at the end explains
 * a pause nobody asked for, where a pause a second earlier is somebody's
 * finger and excusing it means resuming over them on the next tick.
 *
 * Asked of `prev` by the track clause, as the backstop for a rollover that was
 * never registered — the reading that would have registered it never arrived.
 * It is the plain, unprojected question: was the player already at the end when
 * we last looked?
 */
function parkedAtTheEnd(obs: Observation): boolean {
  return obs.durationMs > 0 && obs.positionMs >= obs.durationMs - RAN_OUT_SLACK_MS;
}

/**
 * Did the position move further than time alone accounts for?
 *
 * A playing track advances by the wall time between readings; a paused one
 * holds still. Falling *short* of that is a stall — a buffer, a slow tick — and
 * is never a person. Only a genuine jump counts, and only when nothing of ours
 * could have caused it.
 *
 * A seek only explains the position it was aiming at. One that has expired, or
 * that aimed somewhere else entirely, leaves a jump unaccounted for — which is
 * the point, because the user seeking while our own seek is in flight is
 * exactly the case that must still be caught.
 *
 * Zero is the exception to all of it. A playing track reporting 0 is Spotify
 * still loading, not a position: it holds there for as long as the buffer takes
 * — past the life of the seek that was meant to place it — and the jump to the
 * real position when it finally starts is the load finishing, not a person.
 */
function jumped(prev: Observation, obs: Observation, outstanding: Expectation[]): boolean {
  if (prev.positionMs === 0 && !prev.isPaused) return false;
  if (playPendingFor(outstanding, obs.trackUri)) return false;
  if (seekExplains(outstanding, obs)) return false;
  const expected = prev.isPaused ? prev.positionMs : prev.positionMs + (obs.at - prev.at);
  return Math.abs(obs.positionMs - expected) > JUMP_SLACK_MS;
}

/** Is a seek in flight that would accept the position we are looking at? */
function seekExplains(outstanding: Expectation[], obs: Observation): boolean {
  return outstanding.some((e) => e.what.kind === "seek" && holds(e, obs));
}
