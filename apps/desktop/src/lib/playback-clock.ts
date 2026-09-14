import type { PlaybackPointer } from "./room";

export const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerPubkey: null,
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
