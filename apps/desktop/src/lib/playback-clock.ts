import type { PlaybackPointer, SessionEntry } from "./room";

export const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerId: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

/** Where in the track the room is right now, in milliseconds. */
export function positionMs(p: PlaybackPointer, nowEpochMs: number): number {
  if (p.itemId === null) return 0;
  if (p.isPaused) return Math.max(0, p.pausedAtOffsetMs);
  return Math.max(0, nowEpochMs - p.startedAtEpochMs);
}

/** Freezes the current position into the pointer so every peer pauses at the same offset. */
export function pausedPointer(p: PlaybackPointer, nowEpochMs: number): PlaybackPointer {
  if (p.isPaused) return p;
  return { ...p, isPaused: true, pausedAtOffsetMs: positionMs(p, nowEpochMs) };
}

/** Restarts the clock from the frozen offset, so position is continuous across the pause. */
export function resumedPointer(p: PlaybackPointer, nowEpochMs: number): PlaybackPointer {
  if (!p.isPaused) return p;
  return {
    ...p,
    isPaused: false,
    startedAtEpochMs: nowEpochMs - Math.max(0, p.pausedAtOffsetMs),
    pausedAtOffsetMs: 0,
  };
}

/**
 * Moves the pointer to a new position in the same item, keeping its play state.
 * Playing: the clock's origin shifts so `now` reads as `positionMs`. Paused: the
 * frozen offset moves instead. An empty pointer has nowhere to seek.
 */
export function seekedPointer(
  p: PlaybackPointer,
  positionMs: number,
  nowEpochMs: number,
): PlaybackPointer {
  if (p.itemId === null) return p;
  const target = Math.max(0, positionMs);
  if (p.isPaused) return { ...p, pausedAtOffsetMs: target };
  return { ...p, startedAtEpochMs: nowEpochMs - target };
}

/**
 * The pointer for a track that just started. `positionMs` says how far into it
 * the player already is — Spotify's own gapless transition lands a little past
 * zero, so the clock origin shifts back to match.
 */
export function startedPointer(
  entry: SessionEntry,
  nowEpochMs: number,
  positionMs = 0,
): PlaybackPointer {
  return {
    itemId: entry.item.id,
    ownerId: entry.ownerId,
    uri: entry.item.uri,
    startedAtEpochMs: nowEpochMs - Math.max(0, positionMs),
    isPaused: false,
    pausedAtOffsetMs: 0,
  };
}
