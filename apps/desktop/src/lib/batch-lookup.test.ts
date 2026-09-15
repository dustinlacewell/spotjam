import { describe, expect, it } from "vitest";
import { createBatchLookup, type BatchRun } from "./batch-lookup";

/** A harness with a manual clock and a manual flush, so nothing is timing-dependent. */
function harness(run: BatchRun<string>, maxBatch = 50) {
  let clock = 0;
  const flushes: (() => void)[] = [];
  const lookup = createBatchLookup(run, {
    maxBatch,
    missTtlMs: 1000,
    now: () => clock,
    schedule: (flush) => flushes.push(flush),
  });
  const flush = () => {
    const pending = flushes.splice(0);
    pending.forEach((f) => f());
  };
  return { lookup, flush, advance: (ms: number) => (clock += ms) };
}

function upperOrNull(keys: string[]): Promise<(string | null)[]> {
  return Promise.resolve(keys.map((k) => (k.startsWith("miss") ? null : k.toUpperCase())));
}

describe("createBatchLookup", () => {
  it("coalesces lookups made in one tick into one run call", async () => {
    const calls: string[][] = [];
    const h = harness((keys) => {
      calls.push(keys);
      return upperOrNull(keys);
    });

    const a = h.lookup("a");
    const b = h.lookup("b");
    const aAgain = h.lookup("a");
    h.flush();

    expect(await Promise.all([a, b, aAgain])).toEqual(["A", "B", "A"]);
    expect(calls).toEqual([["a", "b"]]);
  });

  it("splits a tick's keys into chunks of maxBatch", async () => {
    const calls: string[][] = [];
    const h = harness((keys) => {
      calls.push(keys);
      return upperOrNull(keys);
    }, 2);

    const all = Promise.all(["a", "b", "c"].map(h.lookup));
    h.flush();
    await all;

    expect(calls).toEqual([["a", "b"], ["c"]]);
  });

  it("serves a hit from cache without another run call", async () => {
    const calls: string[][] = [];
    const h = harness((keys) => {
      calls.push(keys);
      return upperOrNull(keys);
    });

    const first = h.lookup("a");
    h.flush();
    await first;
    expect(await h.lookup("a")).toBe("A");
    expect(calls).toHaveLength(1);
  });

  it("remembers a miss until the ttl passes, then asks again", async () => {
    const calls: string[][] = [];
    const h = harness((keys) => {
      calls.push(keys);
      return upperOrNull(keys);
    });

    const first = h.lookup("miss-1");
    h.flush();
    expect(await first).toBeNull();

    h.advance(500);
    expect(await h.lookup("miss-1")).toBeNull();
    expect(calls).toHaveLength(1);

    h.advance(600);
    const retry = h.lookup("miss-1");
    h.flush();
    await retry;
    expect(calls).toHaveLength(2);
  });

  it("treats a failed run as a miss for every key in the chunk", async () => {
    const h = harness(() => Promise.reject(new Error("boom")));

    const a = h.lookup("a");
    const b = h.lookup("b");
    h.flush();

    expect(await Promise.all([a, b])).toEqual([null, null]);
    expect(await h.lookup("a")).toBeNull();
  });
});
