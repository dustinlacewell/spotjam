import type { PlaybackPointer, Progress } from "@spotjam/protocol";

/**
 * Where playback sits, and how much we know about it.
 *
 * A sample carries the track length, so the bar can be placed within it. The
 * pointer alone dates the playback but not its length, which is a real state:
 * a listener whose own player is silent has no sample to report, and the
 * broadcaster's first relay has yet to arrive. Splitting the two keeps an
 * unknown length out of `durationMs`, so no caller can divide by it.
 */
export type PlaybackProgress =
  | { kind: "measured"; positionMs: number; durationMs: number }
  | { kind: "elapsed-only"; positionMs: number };

/**
 * Where the progress bar sits right now, or null when nothing is playing.
 *
 * While paused the pointer carries the frozen offset. While playing the newest
 * peer sample is extrapolated forward to `nowEpochMs`. With no usable sample
 * the pointer still dates the playback, so the clock counts honestly from it.
 */
export function displayedProgress(
  pointer: PlaybackPointer,
  progress: Progress | null,
  nowEpochMs: number,
): PlaybackProgress | null {
  if (pointer.itemId === null) return null;
  if (!progress || progress.itemId !== pointer.itemId) {
    return { kind: "elapsed-only", positionMs: elapsedFromPointer(pointer, nowEpochMs) };
  }
  const durationMs = progress.durationMs;
  const raw = pointer.isPaused
    ? pointer.pausedAtOffsetMs
    : progress.positionMs + (nowEpochMs - progress.sampledAtEpochMs);
  return { kind: "measured", positionMs: clamp(raw, 0, durationMs), durationMs };
}

/**
 * The position the pointer implies on its own. Not capped at the top: no
 * length is known here, and inventing one would stall the clock at a guess.
 */
function elapsedFromPointer(pointer: PlaybackPointer, nowEpochMs: number): number {
  const raw = pointer.isPaused ? pointer.pausedAtOffsetMs : nowEpochMs - pointer.startedAtEpochMs;
  return Math.max(0, raw);
}

/** Stands in for a clock whose value is not known. */
export const PLACEHOLDER_CLOCK = "–:––";

/** What the two clocks and the bar render for one progress reading. */
export interface TrackProgressView {
  elapsedText: string;
  trailingText: string;
  fraction: number;
  seekable: boolean;
  /** Playing, but with no length to place the position within. */
  indeterminate: boolean;
}

/**
 * The clocks and bar for one reading.
 *
 * The two clocks are decided apart: elapsed is known whenever anything plays,
 * while the trailing length needs a measured sample. Without a length there is
 * no fraction to draw and nowhere to seek to, so the bar goes inert.
 */
export function trackProgressView(progress: PlaybackProgress | null): TrackProgressView {
  if (progress === null) {
    return {
      elapsedText: PLACEHOLDER_CLOCK,
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: false,
    };
  }
  const elapsedText = formatClock(progress.positionMs);
  if (progress.kind === "elapsed-only" || progress.durationMs <= 0) {
    return {
      elapsedText,
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: true,
    };
  }
  return {
    elapsedText,
    trailingText: formatClock(progress.durationMs),
    fraction: progress.positionMs / progress.durationMs,
    seekable: true,
    indeterminate: false,
  };
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
