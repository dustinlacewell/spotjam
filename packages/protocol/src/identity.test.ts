import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  publicKeyOf,
  signBytes,
  verifyBytes,
  isPublicKeyHex,
  isSignatureHex,
  shortKey,
} from "./identity.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("keypairs", () => {
  it("generates distinct, well-formed keys", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(isPublicKeyHex(a.publicKey)).toBe(true);
    expect(a.secretKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the same public key from a secret key", () => {
    const kp = generateKeypair();
    expect(publicKeyOf(kp.secretKey)).toBe(kp.publicKey);
  });
});

describe("sign / verify", () => {
  it("verifies a signature it produced", () => {
    const kp = generateKeypair();
    const sig = signBytes(bytes("hello"), kp.secretKey);
    expect(isSignatureHex(sig)).toBe(true);
    expect(verifyBytes(bytes("hello"), sig, kp.publicKey)).toBe(true);
  });

  it("fails on altered bytes", () => {
    const kp = generateKeypair();
    const sig = signBytes(bytes("hello"), kp.secretKey);
    expect(verifyBytes(bytes("hellp"), sig, kp.publicKey)).toBe(false);
  });

  it("fails against a different key", () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const sig = signBytes(bytes("hello"), kp.secretKey);
    expect(verifyBytes(bytes("hello"), sig, other.publicKey)).toBe(false);
  });

  it("returns false rather than throwing on junk", () => {
    const kp = generateKeypair();
    expect(verifyBytes(bytes("hello"), "zz", kp.publicKey)).toBe(false);
    expect(verifyBytes(bytes("hello"), "ab".repeat(64), "zz")).toBe(false);
  });
});

describe("helpers", () => {
  it("validates hex shapes", () => {
    expect(isPublicKeyHex("ab".repeat(32))).toBe(true);
    expect(isPublicKeyHex("ab".repeat(31))).toBe(false);
    expect(isPublicKeyHex("AB".repeat(32))).toBe(false);
    expect(isSignatureHex("ab".repeat(64))).toBe(true);
    expect(isSignatureHex("ab".repeat(63))).toBe(false);
  });

  it("shortens a key for display", () => {
    expect(shortKey("ab".repeat(32))).toBe("abababab");
  });
});
