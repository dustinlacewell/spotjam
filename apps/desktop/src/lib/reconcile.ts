// reconcile — what to tell Spotify, given what it does and what the room says.
//
// The driver is level-triggered: every tick it reads the player and calls this,
// which compares the two pictures and returns the commands that close the gap.
// Nothing here remembers what was applied. A command that never landed is
// simply issued again on the next tick.
//
// The one thing it does remember is a rate limit. Spotify reports the old track
// and the old position for a moment after a play or a seek, so the same target
// is not re-issued inside the grace window. Pure: no I/O, no clock of its own.

import type { PlayerState } from "./sync-driver";

export type Command =
  | { kind: "play"; uri: string }
  | { kind: "seek"; positionMs: number }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "set-next"; uri: string }
  | { kind: "clear-queue" };

/** What the room says the local player should be doing. */
export interface Desired {
  uri: string;
  positionMs: number;
  isPaused: boolean;
  nextUri: string | null;
}

/** What the local player actually does. */
export interface Actual {
  state: PlayerState;
  queueHead: string | null;
}

/**
 * Rate limits only. A play or seek is not repeated for the same target inside
 * GRACE_MS, because Spotify reports the old track/position while it loads.
 */
export interface Memo {
  playedUri: string | null;
  playedAt: number;
  seekTo: number | null;
  seekAt: number;
}

/** How long a play or seek is given to show up in what Spotify reports. */
export const GRACE_MS = 5000;
/** Local drift this far from the shared clock is corrected by seeking. */
export const MAX_DRIFT_MS = 3000;
/** Below this, a start is close enough to the top that seeking is not worth it. */
export const SEEK_THRESHOLD_MS = 2000;

/** A memo that has issued nothing, for a fresh driver or a fresh item. */
export function freshMemo(): Memo {
  return { playedUri: null, playedAt: 0, seekTo: null, seekAt: 0 };
}

export function reconcile(
  desired: Desired,
  actual: Actual,
  memo: Memo,
  now: number,
): { commands: Command[]; memo: Memo } {
  const commands: Command[] = [];
  let next = memo;

  const track = reconcileTrack(desired, actual.state, next, now);
  commands.push(...track.commands);
  next = track.memo;

  // A play was just issued, or the player is still loading the right track:
  // pause and drift mean nothing until it reports the track we asked for.
  if (actual.state.trackUri === desired.uri) {
    const pause = reconcilePause(desired, actual.state, next, now);
    commands.push(...pause.commands);
    next = pause.memo;

    if (pause.commands.length === 0) {
      const drift = reconcileDrift(desired, actual.state, next, now);
      commands.push(...drift.commands);
      next = drift.memo;
    }
  }

  commands.push(...reconcileQueue(desired, actual.queueHead));
  return { commands, memo: next };
}

/** Spotify is on the wrong track: start the right one and place it on the clock. */
function reconcileTrack(
  desired: Desired,
  state: PlayerState,
  memo: Memo,
  now: number,
): { commands: Command[]; memo: Memo } {
  if (state.trackUri === desired.uri) return { commands: [], memo };
  if (memo.playedUri === desired.uri && now - memo.playedAt < GRACE_MS) {
    return { commands: [], memo };
  }

  const commands: Command[] = [{ kind: "play", uri: desired.uri }];
  let next: Memo = { ...memo, playedUri: desired.uri, playedAt: now };
  if (desired.positionMs > SEEK_THRESHOLD_MS) {
    commands.push({ kind: "seek", positionMs: desired.positionMs });
    next = { ...next, seekTo: desired.positionMs, seekAt: now };
  }
  if (desired.isPaused) commands.push({ kind: "pause" });
  return { commands, memo: next };
}

/**
 * On the right track, the wrong play state. A resume re-aligns to the clock,
 * but only when the player is actually off it: a room paused and resumed
 * quickly leaves the player where it belongs, and seeking there would re-buffer
 * a track that was about to carry on playing in the right place.
 */
function reconcilePause(
  desired: Desired,
  state: PlayerState,
  memo: Memo,
  now: number,
): { commands: Command[]; memo: Memo } {
  if (state.isPaused === desired.isPaused) return { commands: [], memo };
  if (desired.isPaused) return { commands: [{ kind: "pause" }], memo };
  const commands: Command[] = [{ kind: "resume" }];
  if (Math.abs(state.positionMs - desired.positionMs) <= MAX_DRIFT_MS) {
    return { commands, memo };
  }
  commands.push({ kind: "seek", positionMs: desired.positionMs });
  return { commands, memo: { ...memo, seekTo: desired.positionMs, seekAt: now } };
}

/**
 * On the right track, playing, and off the shared clock. Position 0 means
 * Spotify is still buffering: seeking then fights the load, not the drift.
 */
function reconcileDrift(
  desired: Desired,
  state: PlayerState,
  memo: Memo,
  now: number,
): { commands: Command[]; memo: Memo } {
  // A paused player holds still, so its reported position is exact and a
  // difference is a seek somebody made in the room. A playing one at 0 is
  // still buffering: seeking then fights the load, not the drift.
  if (!state.isPaused && state.positionMs <= 0) return { commands: [], memo };
  if (Math.abs(state.positionMs - desired.positionMs) <= MAX_DRIFT_MS) {
    return { commands: [], memo };
  }
  if (memo.seekTo !== null && now - memo.seekAt < GRACE_MS) return { commands: [], memo };
  if (lastSeekDidNotHold(desired, state, memo, now)) return { commands: [], memo };
  return {
    commands: [{ kind: "seek", positionMs: desired.positionMs }],
    memo: { ...memo, seekTo: desired.positionMs, seekAt: now },
  };
}

/**
 * Did the last seek land and still leave the player behind?
 *
 * A player that lags the room by a constant amount — a slow network, a long
 * buffer — is not drifting. Seeking it re-buffers the track and it comes back
 * the same distance behind, so chasing it means an audible stutter every grace
 * window, forever.
 *
 * The residual tells the two cases apart. Had the seek landed, the player would
 * now report roughly `seekTo` plus the time since. A player only a little off
 * that took the seek and is simply steady there: that gap is where it lives, so
 * leave it alone. A player far from it never took the seek at all, or a person
 * has since moved it — either way the seek is still worth issuing.
 *
 * The distance is what counts, not its sign. A player that reports a little
 * ahead of the ideal is as steady as one that reports a little behind, and
 * seeking it back re-buffers it into the same place just the same.
 *
 * None of that holds once the room itself has moved. The reasoning compares the
 * player with where our own last seek would have carried it, and it only means
 * "the player is steady" while the room has run on from that seek at the same
 * rate. Somebody dragging the room somewhere else makes the gap the room's, not
 * the player's, and that gap is exactly what a seek is for.
 */
function lastSeekDidNotHold(
  desired: Desired,
  state: PlayerState,
  memo: Memo,
  now: number,
): boolean {
  if (memo.seekTo === null || state.isPaused) return false;
  const landedAt = memo.seekTo + (now - memo.seekAt);
  if (Math.abs(landedAt - desired.positionMs) > MAX_DRIFT_MS) return false;
  const residual = Math.abs(landedAt - state.positionMs);
  return residual > 0 && residual <= 2 * MAX_DRIFT_MS;
}

/**
 * Spotify's own one-slot queue is kept equal to the head of the session queue,
 * so the player transitions gaplessly into the right track by itself. An empty
 * head clears it, which also stops Spotify's context autoplay inventing a track.
 */
function reconcileQueue(desired: Desired, queueHead: string | null): Command[] {
  if (queueHead === desired.nextUri) return [];
  if (desired.nextUri === null) return [{ kind: "clear-queue" }];
  return [{ kind: "set-next", uri: desired.nextUri }];
}
