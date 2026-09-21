// Replay guard — rejects an envelope whose nonce was already spent.
//
// `open()` verifies the signature and bounds the timestamp, but a valid
// envelope captured off the wire stays valid for the whole replay window.
// The nonce closes that hole: each one is accepted once.
//
// Memory is bounded by the window, not by traffic. An envelope older than the
// window is refused by `open()` before it reaches here, so a nonce seen longer
// ago than that can never be presented again and is safe to forget.

import { REPLAY_WINDOW_MS } from "@spotjam/protocol";

export interface ReplayGuardOptions {
  /** How long a nonce stays remembered. Must match the envelope window. */
  windowMs?: number;
  /** Hard ceiling on remembered nonces, so a flood cannot exhaust memory. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Bounded set of spent nonces.
 *
 * Not pure — it is a store — but it holds no clock: every method takes `now`,
 * so eviction is deterministic under test.
 */
export class ReplayGuard {
  readonly #windowMs: number;
  readonly #maxEntries: number;
  /** nonce -> epoch ms when the entry may be forgotten. Not ordered by expiry. */
  readonly #seen = new Map<string, number>();

  constructor(options: ReplayGuardOptions = {}) {
    this.#windowMs = options.windowMs ?? REPLAY_WINDOW_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Record a nonce. True when it is fresh, false when it is a replay.
   *
   * `timestamp` is the envelope's own sender-stamped time. A future-dated
   * envelope stays signature-valid until `timestamp + windowMs`, which can be
   * long after its arrival instant has passed through the window — so the
   * entry's expiry is the *later* of the two: the nonce is remembered until
   * the envelope itself can no longer be replayed.
   *
   * A replay does not refresh the stored expiry: the original sighting
   * decides when the entry expires, so a repeated nonce cannot pin an entry
   * in memory forever.
   */
  admit(nonce: string, now: number, timestamp: number): boolean {
    this.evictExpired(now);

    if (this.#seen.has(nonce)) return false;

    this.#seen.set(nonce, Math.max(now, timestamp) + this.#windowMs);
    this.evictOverflow();
    return true;
  }

  /** Remembered nonces. Exposed for tests and health reporting. */
  get size(): number {
    return this.#seen.size;
  }

  /**
   * Drop every entry whose envelope can no longer be replayed.
   *
   * Strictly expired, not as-expired: `open()` still accepts an envelope
   * whose age is exactly the window, so its nonce has to stay spent for
   * exactly as long — forgetting it one tick early would reopen a replay.
   */
  evictExpired(now: number): void {
    // Expiry = max(now, ts) + windowMs, so a future-dated envelope admitted
    // early can outlive later entries: expiry is not monotonic in insertion
    // order, so scan the whole map instead of stopping at the first survivor.
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt < now) this.#seen.delete(nonce);
    }
  }

  /**
   * Trim to the ceiling, oldest first.
   *
   * Only reachable under a flood of distinct nonces inside one window. Dropping
   * the oldest risks re-admitting a nonce whose envelope has not yet expired,
   * which is strictly better than an unbounded map.
   */
  private evictOverflow(): void {
    while (this.#seen.size > this.#maxEntries) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) return;
      this.#seen.delete(oldest.value);
    }
  }
}
