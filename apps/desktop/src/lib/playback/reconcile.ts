// reconcile — the commands that close the gap between wanted and observed.
//
// Level-triggered and pure: no memo, no clock, no memory of what was applied.
// Every tick asks the same question of the current pair of pictures. The only
// thing that stops a command repeating is an expectation for it still being in
// flight, and that list is passed in.

import type { Command } from "./commands.js";
import type { Desired } from "./desired.js";
import { arriving, pending, type Expectation } from "./expectations.js";
import { isAd, type Observation } from "./observation.js";
import { freshStuck, isStuck, type StuckState } from "./stuck.js";

/** Local drift this far from the shared clock is corrected by seeking. */
const MAX_DRIFT_MS = 3000;

export function reconcile(
  desired: Desired,
  obs: Observation,
  outstanding: Expectation[],
  stuck: StuckState = freshStuck(),
  now: number = obs.at,
): Command[] {
  if (desired.kind === "idle") return idleCommands(obs, outstanding);
  return [
    ...transportCommands(desired, obs, outstanding, stuck, now),
    // The queue slot is reconciled whatever the transport is doing. It is the
    // one thing still worth getting right on a track that is ending, on an
    // advert, and on a track that will not start.
    ...queueCommands(desired.nextUri, obs, outstanding),
  ];
}

/**
 * The room is playing nothing. Stop the player and empty its queue slot, so
 * Spotify's own autoplay does not invent a track for a room that has none.
 */
function idleCommands(obs: Observation, outstanding: Expectation[]): Command[] {
  const commands: Command[] = [];
  if (!obs.isPaused && !pending(outstanding, "pause")) commands.push({ kind: "pause" });
  if (obs.queueHead !== null && !pending(outstanding, "clear-queue")) {
    commands.push({ kind: "clear-queue" });
  }
  return commands;
}

/**
 * Track, then play state, then position — in that order, one concern per tick.
 *
 * Nothing below the track matters while Spotify is on the wrong one: its pause
 * flag and its position belong to a track we are about to leave.
 *
 * One reading means the player is not ours to correct at all: an advert is
 * Spotify's own business and ends by itself, and correcting against it would
 * fight the ad break for its whole length.
 *
 * The end of a track needs no rule here. A rollover is outstanding across it,
 * and `startTrack` treats a track that is on its way as one already being
 * started — whether we asked for it or Spotify is about to reach it alone.
 */
function transportCommands(
  desired: Extract<Desired, { kind: "play" }>,
  obs: Observation,
  outstanding: Expectation[],
  stuck: StuckState,
  now: number,
): Command[] {
  if (isAd(obs.trackUri)) return [];
  if (obs.trackUri !== desired.uri) return startTrack(desired, outstanding, stuck, now);
  if (obs.isPaused !== desired.paused) return setPlayState(desired, outstanding);
  return correctDrift(desired, obs, outstanding);
}

/**
 * The wrong track: start the right one. Nothing else.
 *
 * The placing and the pausing wait for the track to arrive. A seek issued in
 * the same breath as the play reaches Spotify while the track is still loading,
 * lands on nothing, and is lost — and because it counts as in flight, it blocks
 * the drift correction that would have placed the track properly, for the whole
 * life of its expectation. The player then sits at the wrong offset for
 * seconds, audibly.
 *
 * Once the track is observed the ordinary branches do the rest: `setPlayState`
 * holds it if the room is paused, and `correctDrift` places it once Spotify
 * reports a real position. That is a tick or two later than the old group, and
 * a tick or two of correct is worth more than an instant of lost.
 *
 * A track already on its way is not started again. That covers our own play
 * still landing and Spotify's own transition about to reach it: both are the
 * same fact, and starting the track on top of either plays it twice.
 */
function startTrack(
  desired: Extract<Desired, { kind: "play" }>,
  outstanding: Expectation[],
  stuck: StuckState,
  now: number,
): Command[] {
  if (arriving(outstanding, desired.uri)) return [];
  const play: Command = { kind: "play", uri: desired.uri };
  if (isStuck(stuck, play, now)) return [];
  return [play];
}

/**
 * The right track, the wrong play state. Pause or resume, nothing else.
 *
 * The placing is not this branch's business. `correctDrift` runs on the next
 * tick and puts the track where the room says, paused or playing alike — and it
 * retries, which a seek bundled in here would not.
 */
function setPlayState(
  desired: Extract<Desired, { kind: "play" }>,
  outstanding: Expectation[],
): Command[] {
  if (pending(outstanding, "pause") || pending(outstanding, "resume")) return [];
  return [desired.paused ? { kind: "pause" } : { kind: "resume" }];
}

/** Far enough from where the room says it should be to be worth a seek. */
function offTheClock(desired: Extract<Desired, { kind: "play" }>, obs: Observation): boolean {
  return Math.abs(obs.positionMs - desired.positionMs) > MAX_DRIFT_MS;
}

/**
 * The right track, the right play state, the wrong position.
 *
 * A paused room is placed here too. Its clock is frozen, so nothing drifts —
 * but somebody can still seek a paused room, and the pause that the join issued
 * can land while the seek beside it is lost. Either way the player sits at the
 * wrong offset and only this branch will move it. Because it is level-triggered
 * it also retries, which is what makes a dropped seek recoverable at all.
 *
 * Position 0 on a *playing* track is Spotify still buffering, not the player
 * being at the top: seeking then fights the load rather than the drift. A
 * paused player at 0 is genuinely stopped at the top, and a room that wants it
 * elsewhere is right.
 */
function correctDrift(
  desired: Extract<Desired, { kind: "play" }>,
  obs: Observation,
  outstanding: Expectation[],
): Command[] {
  if (!offTheClock(desired, obs)) return [];
  if (!obs.isPaused && obs.positionMs <= 0) return [];
  if (pending(outstanding, "seek")) return [];
  return [{ kind: "seek", positionMs: desired.positionMs }];
}

/**
 * Spotify's own one-slot queue is kept equal to the head of the session queue,
 * so the player transitions gaplessly into the right track by itself. An empty
 * head clears it, which also stops Spotify's context autoplay inventing a track.
 *
 * The slot is left alone while a rollover is counting on what is in it. Our
 * clock reaches the next item a beat before the player does, and at that moment
 * the room wants the slot cleared — but clearing it is exactly how the seamless
 * step we are waiting for gets cancelled. A tick later the transition has
 * happened and the slot is reconciled against the room as usual.
 */
function queueCommands(
  nextUri: string | null,
  obs: Observation,
  outstanding: Expectation[],
): Command[] {
  if (obs.queueHead === nextUri) return [];
  if (arriving(outstanding, obs.queueHead)) return [];
  if (pending(outstanding, "set-next") || pending(outstanding, "clear-queue")) return [];
  return nextUri === null ? [{ kind: "clear-queue" }] : [{ kind: "set-next", uri: nextUri }];
}
