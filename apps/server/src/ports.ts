// Ports — the seams the pure core is allowed to depend on.
//
// The core computes; it never reads a clock or a random source directly. Both
// arrive as arguments so a test can pin time and randomness and get the same
// answer every run.

/** Epoch-ms clock. The shell passes Date.now; tests pass a fake. */
export interface Clock {
  now(): number;
}

/** Uniform [0, 1) source, shaped like Math.random so seeding is a swap. */
export type Rng = () => number;

/** Wall clock, for the shell. */
export const systemClock: Clock = { now: () => Date.now() };
