// What the progress bar and its two clocks show, for one playback reading.
//
// Pure: the position and the length come in as numbers. Where they came from —
// `positionAt` over a settled pointer, on the server's clock — is the caller's
// business.

/** Stands in for a clock whose value is not known. */
export const PLACEHOLDER_CLOCK = "–:––";

/** What the two clocks and the bar render for one reading. */
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
 * while the trailing length needs a real duration. Without one there is no
 * fraction to draw and nowhere to seek to, so the bar goes inert.
 *
 * `positionMs` null means nothing is playing at all: both clocks blank.
 */
export function trackProgressView(
  positionMs: number | null,
  durationMs: number,
): TrackProgressView {
  if (positionMs === null) {
    return {
      elapsedText: PLACEHOLDER_CLOCK,
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: false,
    };
  }
  const elapsedText = formatClock(positionMs);
  if (durationMs <= 0) {
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
    trailingText: formatClock(durationMs),
    fraction: Math.min(1, Math.max(0, positionMs / durationMs)),
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
