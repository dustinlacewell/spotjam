import { describe, expect, it } from "vitest";

import { ReplayGuard } from "./replay-guard.ts";

describe("ReplayGuard", () => {
  it("admits a nonce once", () => {
    const guard = new ReplayGuard({ windowMs: 60_000 });
    expect(guard.admit("a", 1000)).toBe(true);
    expect(guard.admit("a", 1000)).toBe(false);
  });

  it("keeps distinct nonces independent", () => {
    const guard = new ReplayGuard({ windowMs: 60_000 });
    expect(guard.admit("a", 1000)).toBe(true);
    expect(guard.admit("b", 1000)).toBe(true);
    expect(guard.size).toBe(2);
  });

  it("forgets a nonce once it leaves the window", () => {
    const guard = new ReplayGuard({ windowMs: 60_000 });
    guard.admit("a", 1000);
    // Past the window the envelope itself is stale, so re-admitting is safe.
    expect(guard.admit("a", 1000 + 60_002)).toBe(true);
  });

  it("still rejects a repeat at the window edge", () => {
    const guard = new ReplayGuard({ windowMs: 60_000 });
    guard.admit("a", 1000);
    expect(guard.admit("a", 1000 + 60_000)).toBe(false);
  });

  it("evicts expired entries so the store does not grow without bound", () => {
    const guard = new ReplayGuard({ windowMs: 1_000 });
    for (let i = 0; i < 500; i++) guard.admit(`n${i}`, 1000 + i);
    expect(guard.size).toBe(500);

    guard.admit("later", 1000 + 500 + 1_002);
    expect(guard.size).toBe(1);
  });

  it("never exceeds the entry ceiling", () => {
    const guard = new ReplayGuard({ windowMs: 60_000, maxEntries: 10 });
    for (let i = 0; i < 100; i++) guard.admit(`n${i}`, 1000);
    expect(guard.size).toBe(10);
  });

  it("does not let a repeated nonce refresh its own expiry", () => {
    const guard = new ReplayGuard({ windowMs: 10_000 });
    guard.admit("a", 1000);
    guard.admit("a", 5000);
    // Expiry is measured from the first sighting, not the latest attempt.
    expect(guard.admit("a", 11_002)).toBe(true);
  });
});
