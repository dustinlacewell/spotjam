// Clock offset — how far this machine's clock sits from the server's.
//
// The server advances the pointer on its own clock and stamps every snapshot
// with `serverTime`. To read a pointer, a client must convert its own `now`
// into the server's frame. That is all this file does: fold samples into one
// offset, and apply it.
//
// Pure. No clock is read here; the shell passes `localNow` in.

/**
 * How much of a new sample survives into the offset.
 *
 * A single sample carries the whole round trip's jitter, so a raw swap makes
 * the bar stutter. Blending damps that. 0.2 converges in a handful of
 * snapshots while ignoring one late frame.
 */
export const OFFSET_ALPHA = 0.2;

/**
 * Fold one `serverTime` sample into the running offset.
 *
 * The first sample is taken whole: there is nothing to blend with, and a
 * client that waited for convergence would draw a wrong bar until it came.
 */
export function foldOffset(prev: number | null, serverTime: number, localNow: number): number {
  const sample = serverTime - localNow;
  if (prev === null) return sample;
  return prev + OFFSET_ALPHA * (sample - prev);
}

/** This instant, in the server's clock. */
export function serverNow(offset: number, localNow: number): number {
  return localNow + offset;
}
