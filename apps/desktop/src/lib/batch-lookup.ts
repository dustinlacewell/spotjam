/**
 * Turns a "look up many keys at once" function into a per-key lookup that
 * coalesces the calls made in one tick into batches, caches hits for good,
 * and remembers misses and failures for a short while so a re-render does
 * not re-ask the same question every frame.
 */

export interface BatchLookupOptions {
  /** Most keys sent in one call of `run`. */
  maxBatch: number;
  /** How long a miss or a failure stands before the key is asked again. */
  missTtlMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Defers the flush until the current tick's callers have all queued. */
  schedule?: (flush: () => void) => void;
}

export type Lookup<V> = (key: string) => Promise<V | null>;

/** `run` returns one result per key, in the same order as its input. */
export type BatchRun<V> = (keys: string[]) => Promise<(V | null)[]>;

interface Pending<V> {
  resolve: (value: V | null) => void;
}

export function createBatchLookup<V>(run: BatchRun<V>, options: BatchLookupOptions): Lookup<V> {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? queueMicrotask;

  const hits = new Map<string, V>();
  const missesUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<V | null>>();
  let queued = new Map<string, Pending<V>>();
  let flushScheduled = false;

  function lookup(key: string): Promise<V | null> {
    const hit = hits.get(key);
    if (hit !== undefined) return Promise.resolve(hit);

    const missUntil = missesUntil.get(key);
    if (missUntil !== undefined && missUntil > now()) return Promise.resolve(null);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = new Promise<V | null>((resolve) => {
      queued.set(key, { resolve });
    });
    inFlight.set(key, promise);
    if (!flushScheduled) {
      flushScheduled = true;
      schedule(flush);
    }
    return promise;
  }

  function flush(): void {
    flushScheduled = false;
    const batch = queued;
    queued = new Map();
    const keys = [...batch.keys()];
    for (let start = 0; start < keys.length; start += options.maxBatch) {
      const chunk = keys.slice(start, start + options.maxBatch);
      void runChunk(chunk, batch);
    }
  }

  async function runChunk(keys: string[], batch: Map<string, Pending<V>>): Promise<void> {
    let results: (V | null)[];
    try {
      results = await run(keys);
    } catch {
      results = keys.map(() => null);
    }
    keys.forEach((key, i) => {
      const value = results[i] ?? null;
      if (value === null) missesUntil.set(key, now() + options.missTtlMs);
      else hits.set(key, value);
      inFlight.delete(key);
      batch.get(key)?.resolve(value);
    });
  }

  return lookup;
}
