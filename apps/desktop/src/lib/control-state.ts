// Does this client drive the local Spotify player right now?
//
// Joining a room attaches to Spotify and plays what the room plays, whatever
// the player was doing. After that, a user who switches Spotify to their own
// track takes the player back, and the room stops chasing them.
//
// This module is the pure decision. It reads the room's pointer, what Spotify
// actually plays, and the track pre-queued behind the pointer, and returns one
// of three states. The driver acts on the answer; nothing here does I/O.

import type { PlaybackPointer } from "@spotjam/protocol";

/**
 * - `idle`: the room names no track, so there is nothing to follow.
 * - `following`: the local player is ours to drive.
 * - `detached`: the user took the player back. We watch, we do not touch.
 */
export type ControlState = "idle" | "following" | "detached";

/** The part of the local player's state that decides control. */
export interface LocalPlayback {
  trackUri: string | null;
  isPaused: boolean;
}

/**
 * The next control state.
 *
 * @param prev          the previous state; null on the first evaluation after joining
 * @param local         what Spotify reports; null when the state could not be read
 * @param pointer       the room's playback pointer
 * @param nextUri       the session queue head, pre-queued in Spotify's own one slot
 * @param pointerChanged whether the pointer's itemId differs from the last evaluation
 * @param endReported   whether we have already told the server this item is over
 */
export function nextControlState(
  prev: ControlState | null,
  local: LocalPlayback | null,
  pointer: PlaybackPointer,
  nextUri: string | null,
  pointerChanged: boolean,
  endReported = false,
): ControlState {
  if (pointer.itemId === null) return "idle";
  if (prev === "detached") return reclaimed(local, pointerChanged) ? "following" : "detached";
  if (prev === "following") {
    return keptDriving(local, pointer, nextUri, pointerChanged, endReported)
      ? "following"
      : "detached";
  }
  // First look at a non-empty pointer, from `null` or out of `idle`: the room
  // takes the player, whatever it was doing.
  return "following";
}

/**
 * We were driving: do we keep driving?
 *
 * Letting go means one thing only — the user moved Spotify somewhere the room
 * never asked for, *while the room stood still*. A pointer that just moved is
 * the room's own transition, and at that instant Spotify is still on the track
 * that ended: not the new pointer's track, and not the track now queued behind
 * it. Reading that as the user taking over strands the client — it stops
 * issuing the play, so the track never changes and no progress is reported —
 * and, being detached, it can only come back at another seam while paused.
 *
 * So the seam gets a tick's grace. By the next tick the pointer is unchanged
 * and the usual reading applies: a client the room really did move is on the
 * pointer's track by then, and a user who really did take the player is not.
 *
 * The other seam is the mirror of that one: we have told the server this item
 * is over and the pointer has not moved yet. Spotify has already gone gapless
 * into the track that was queued, and the server may consume that head into the
 * new item before it pushes the pointer, so the player matches neither. Nothing
 * the user did put it there — we did — so the grace holds.
 *
 * `endReported` is the caller's to bound. It says an end is outstanding *now*,
 * not that one was ever seen: a server that never answers must not leave this
 * returning "keep driving" for the rest of the session, so the driver drops the
 * flag once the round trip it covers has plainly failed.
 */
function keptDriving(
  local: LocalPlayback | null,
  pointer: PlaybackPointer,
  nextUri: string | null,
  pointerChanged: boolean,
  endReported: boolean,
): boolean {
  if (pointerChanged) return true;
  if (endReported) return true;
  return stillOnOurTracks(local, pointer, nextUri);
}

/**
 * The player sits on the pointer's track, or on the track we queued behind it
 * — Spotify's own gapless transition lands there. Anywhere else, the user
 * moved it.
 */
function stillOnOurTracks(
  local: LocalPlayback | null,
  pointer: PlaybackPointer,
  nextUri: string | null,
): boolean {
  if (local === null) return true;
  if (local.trackUri === null) return true;
  return local.trackUri === pointer.uri || local.trackUri === nextUri;
}

/**
 * The user has the player. The room only gets it back at a seam: the pointer
 * moved to a new item and the user is not listening to anything right now.
 */
function reclaimed(local: LocalPlayback | null, pointerChanged: boolean): boolean {
  if (!pointerChanged) return false;
  return local !== null && local.isPaused;
}
