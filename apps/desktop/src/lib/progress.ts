import type { PlaybackPointer, Progress } from "./room";

/** A position to render, and the track length it sits in. */
export interface PlaybackProgress {
  positionMs: number;
  durationMs: number;
}

/**
 * Where the progress bar sits right now. While paused the pointer already
 * carries the frozen offset, so no sample is needed to place it. While playing
 * the newest peer sample is extrapolated forward to `nowEpochMs`.
 */
export function displayedProgress(
  pointer: PlaybackPointer,
  progress: Progress | null,
  nowEpochMs: number,
): PlaybackProgress | null {
  if (pointer.itemId === null) return null;
  if (!progress || progress.itemId !== pointer.itemId) return null;
  const durationMs = progress.durationMs;
  const raw = pointer.isPaused
    ? pointer.pausedAtOffsetMs
    : progress.positionMs + (nowEpochMs - progress.sampledAtEpochMs);
  return { positionMs: clamp(raw, 0, durationMs), durationMs };
}

/** Milliseconds as "m:ss". Floors to the second; anything negative reads 0:00. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
