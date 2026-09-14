import { describe, expect, it } from "vitest";
import { canonicalize, canonicalBytes } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys so insertion order cannot change the bytes", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("sorts keys at every depth", () => {
    const a = canonicalize({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const b = canonicalize({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("encodes primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
  });

  it("escapes strings the same way JSON does", () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize("tab\there")).toBe('"tab\\there"');
  });

  it("handles empty containers", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("rejects values with no stable encoding", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(1.5)).toThrow(TypeError);
    // undefined is not a CanonicalValue; cast to reach the runtime guard.
    expect(() => canonicalize({ a: undefined } as never)).toThrow(TypeError);
  });

  it("produces utf-8 bytes", () => {
    const bytes = canonicalBytes({ a: 1 });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });
});
