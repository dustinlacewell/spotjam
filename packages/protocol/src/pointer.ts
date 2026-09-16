// Pointer arithmetic — pure functions over a playback pointer and a clock.
//
// The server advances the pointer on its own clock: nothing here reads a
// clock, does I/O, or remembers anything. `now` is always server-clock ms.

import { NULL_POINTER, type PlaybackPointer, type SessionEntry } from "./events.js";

/** Where in the track the pointer sits at `now` (server clock). 0 when empty. */
export function positionAt(p: PlaybackPointer, now: number): number {
  if (p.itemId === null) return 0;
  const raw = p.isPaused ? p.pausedAtOffsetMs : now - p.startedAtEpochMs;
  const floored = Math.max(0, raw);
  return p.durationMs > 0 ? Math.min(floored, p.durationMs) : floored;
}

/** Server-clock instant the pointed track runs out, or null when empty or paused. */
export function endsAt(p: PlaybackPointer): number | null {
  if (p.itemId === null || p.isPaused) return null;
  return p.startedAtEpochMs + p.durationMs;
}

/**
 * One step of advancing on the clock.
 *
 * Unchanged if the track has not ended. If it has, `next` becomes the pointer,
 * playing, with `startedAtEpochMs` set to the old end — so the clock stays
 * continuous and an overshoot is not lost. With no `next`, the pointer empties.
 */
export function settleOnce(
  p: PlaybackPointer,
  next: SessionEntry | null,
  now: number,
): PlaybackPointer {
  const end = endsAt(p);
  if (end === null || now < end) return p;
  if (next === null) return NULL_POINTER;
  return {
    itemId: next.item.id,
    ownerPubkey: next.ownerPubkey,
    uri: next.item.uri,
    startedAtEpochMs: end,
    isPaused: false,
    pausedAtOffsetMs: 0,
    durationMs: next.item.durationMs,
  };
}
