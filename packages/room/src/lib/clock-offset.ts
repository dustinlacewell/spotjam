// Clock offset — how far this machine's clock sits from the server's.
//
// The server advances the pointer on its own clock and stamps every snapshot
// with `serverTime`. To read a pointer, a client must convert its own `now`
// into the server's frame. That is all this file does: fold samples into one
// offset, and apply it.
//
// A sample is biased: the server stamps `serverTime` when it sends the frame,
// so by the time the client reads its own clock the frame has spent its whole
// network hop in flight. Each sample therefore reads
// `trueOffset − sendLatency`, and every sample is low by however long the
// frame traveled. A mean blend would average that bias in as the steady-state
// value, leaving every listener a hop behind the broadcaster. Instead the
// estimate is the *maximum* sample still in the window: the largest sample is
// the one with the least latency in front of it, the same selection NTP makes
// by taking the minimum round trip. Late frames raise the estimate no higher
// than the truth. A correction that raises the offset shows up as a new larger
// sample and is adopted immediately. A correction that lowers it is not: the
// older, larger samples still hold the maximum until they age out of the
// window, so the estimate falls only once the window rolls past them.
//
// Pure. No clock is read here; the shell passes `localNow` in.

/**
 * How long a sample stays in the window, measured in local arrival time.
 *
 * Long enough to outlast a burst of late frames, short enough that a clock
 * correction moving both machines is picked up within a minute or two of
 * snapshots.
 */
export const OFFSET_WINDOW_MS = 60_000;

/** One `serverTime` reading, pinned to the local clock when it arrived. */
export interface OffsetSample {
  serverTime: number;
  localNow: number;
}

/**
 * Fold one `serverTime` sample into the window.
 *
 * Returns the next window: the new sample plus every prior sample that has
 * not aged out by local arrival time. The first sample is kept whole — there
 * is nothing to wait for, and a client that refused to estimate until a
 * window filled would draw a wrong bar until then.
 */
export function foldSample(
  prev: OffsetSample[] | null,
  serverTime: number,
  localNow: number,
): OffsetSample[] {
  const cutoff = localNow - OFFSET_WINDOW_MS;
  const kept = (prev ?? []).filter((sample) => sample.localNow > cutoff);
  kept.push({ serverTime, localNow });
  return kept;
}

/** The clock offset estimate for a window. Null before any sample has landed. */
export function offsetOf(samples: OffsetSample[] | null): number | null {
  if (samples === null || samples.length === 0) return null;
  let best = -Infinity;
  for (const { serverTime, localNow } of samples) {
    const sample = serverTime - localNow;
    if (sample > best) best = sample;
  }
  return best;
}

/** This instant, in the server's clock. */
export function serverNow(offset: number, localNow: number): number {
  return localNow + offset;
}
