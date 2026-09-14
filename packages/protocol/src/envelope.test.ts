import { describe, expect, it } from "vitest";
import { generateKeypair } from "./identity.js";
import { open, seal, isEnvelope, REPLAY_WINDOW_MS } from "./envelope.js";

const NOW = 1_700_000_000_000;

describe("seal / open", () => {
  it("round-trips a payload", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    const result = open(env, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({ type: "hello" });
    expect(result.pubkey).toBe(id.publicKey);
  });

  it("carries the author's pubkey, not a claimed one", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    expect(env.pubkey).toBe(id.publicKey);
  });

  it("gives every envelope a distinct nonce", () => {
    const id = generateKeypair();
    const a = seal({ type: "hello" }, id, NOW);
    const b = seal({ type: "hello" }, id, NOW);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.signature).not.toBe(b.signature);
  });

  it("verifies regardless of key order in the payload", () => {
    const id = generateKeypair();
    const env = seal({ b: 1, a: 2 } as never, id, NOW);
    // Re-serialize through a different key order, as a transport might.
    const reordered = JSON.parse(
      JSON.stringify({ ...env, payload: { a: 2, b: 1 } }),
    );
    expect(open(reordered, NOW).ok).toBe(true);
  });
});

describe("open — rejection", () => {
  it("rejects a tampered payload", () => {
    const id = generateKeypair();
    const env = seal({ type: "enqueue", n: 1 } as never, id, NOW);
    const tampered = { ...env, payload: { type: "enqueue", n: 999 } };
    expect(open(tampered, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a swapped pubkey", () => {
    const id = generateKeypair();
    const other = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    const forged = { ...env, pubkey: other.publicKey };
    expect(open(forged, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a mutated nonce or timestamp", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    expect(open({ ...env, nonce: "00" }, NOW).ok).toBe(false);
    expect(open({ ...env, timestamp: NOW + 1 }, NOW).ok).toBe(false);
  });

  it("rejects an envelope older than the replay window", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    const later = NOW + REPLAY_WINDOW_MS + 1;
    expect(open(env, later)).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("accepts an envelope at the edge of the window", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    expect(open(env, NOW + REPLAY_WINDOW_MS).ok).toBe(true);
  });

  it("rejects an envelope from too far in the future", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    const earlier = NOW - REPLAY_WINDOW_MS - 1;
    expect(open(env, earlier)).toEqual({ ok: false, reason: "future-timestamp" });
  });

  it("rejects malformed input", () => {
    for (const bad of [null, undefined, 7, "nope", {}, { payload: 1 }]) {
      expect(open(bad, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects non-hex pubkeys and signatures", () => {
    const id = generateKeypair();
    const env = seal({ type: "hello" }, id, NOW);
    expect(open({ ...env, pubkey: "zz" }, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(open({ ...env, signature: "zz" }, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("isEnvelope", () => {
  it("accepts a sealed envelope and rejects junk", () => {
    const id = generateKeypair();
    expect(isEnvelope(seal({ type: "hello" }, id, NOW))).toBe(true);
    expect(isEnvelope({})).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});
