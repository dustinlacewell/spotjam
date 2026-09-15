// How long a room has been up, in the least characters that still say it.
//
// A room browser shows one of these per row, so the string trades precision
// for width: the reader wants "old" or "new", not a duration they can subtract.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Time since `createdAtEpochMs`, as "<1m", "12m", "2h" or "3d".
 *
 * A future creation time reads as "<1m": a clock skewed by a few seconds is
 * far more likely than a room created ahead of now, and "<1m" is true enough.
 */
export function formatUptime(createdAtEpochMs: number, now: number): string {
  const elapsed = now - createdAtEpochMs;
  if (elapsed < MINUTE_MS) return "<1m";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}
