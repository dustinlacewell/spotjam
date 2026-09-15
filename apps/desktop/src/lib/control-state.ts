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
 */
export function nextControlState(
  prev: ControlState | null,
  local: LocalPlayback | null,
  pointer: PlaybackPointer,
  nextUri: string | null,
  pointerChanged: boolean,
): ControlState {
  if (pointer.itemId === null) return "idle";
  if (prev === "detached") return reclaimed(local, pointerChanged) ? "following" : "detached";
  if (prev === "following") return stillOnOurTracks(local, pointer, nextUri) ? "following" : "detached";
  // First look at a non-empty pointer, from `null` or out of `idle`: the room
  // takes the player, whatever it was doing.
  return "following";
}

/**
 * We were driving. We keep driving while the player sits on the pointer's
 * track or on the track we queued behind it — Spotify's own gapless transition
 * lands there. Anywhere else, the user moved it.
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
