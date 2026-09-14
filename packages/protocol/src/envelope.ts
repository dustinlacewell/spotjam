// Envelope — the signed wrapper every client message travels in.
//
// The server trusts nothing but signatures. An envelope binds a payload to the
// public key that authored it, so the server can answer one question for every
// message: does this key own the thing it is trying to change?
//
// Replay is handled by a nonce plus a timestamp. The timestamp bounds how long
// a captured envelope stays useful; the nonce lets the server reject exact
// duplicates inside that window.

import { canonicalBytes, type CanonicalValue } from "./canonical.js";
import {
  isPublicKeyHex,
  isSignatureHex,
  signBytes,
  verifyBytes,
  type PublicKeyHex,
  type SignatureHex,
} from "./identity.js";

/** How far from the server's clock an envelope may sit and still be accepted. */
export const REPLAY_WINDOW_MS = 60_000;

/** A signed message. `payload` is whatever the sender is asserting. */
export interface Envelope<P extends CanonicalValue = CanonicalValue> {
  payload: P;
  /** Author's public key, hex. */
  pubkey: PublicKeyHex;
  /** Unique per envelope; the server rejects repeats inside the replay window. */
  nonce: string;
  /** Sender's clock, epoch ms. */
  timestamp: number;
  /** Signature over the canonical bytes of {payload, pubkey, nonce, timestamp}. */
  signature: SignatureHex;
}

/** The exact shape that gets signed. Order is irrelevant; canonicalize sorts. */
function signingBody<P extends CanonicalValue>(
  payload: P,
  pubkey: PublicKeyHex,
  nonce: string,
  timestamp: number,
): CanonicalValue {
  return { nonce, payload, pubkey, timestamp };
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Wrap and sign a payload. */
export function seal<P extends CanonicalValue>(
  payload: P,
  identity: { publicKey: PublicKeyHex; secretKey: string },
  now: number = Date.now(),
): Envelope<P> {
  const nonce = randomNonce();
  const body = signingBody(payload, identity.publicKey, nonce, now);
  return {
    payload,
    pubkey: identity.publicKey,
    nonce,
    timestamp: now,
    signature: signBytes(canonicalBytes(body), identity.secretKey),
  };
}

/** Why an envelope was refused. */
export type OpenFailure =
  | "malformed"
  | "bad-signature"
  | "stale-timestamp"
  | "future-timestamp";

export type OpenResult<P extends CanonicalValue> =
  | { ok: true; payload: P; pubkey: PublicKeyHex; nonce: string }
  | { ok: false; reason: OpenFailure };

/** True when the value has the structural shape of an envelope. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.pubkey === "string" &&
    typeof e.nonce === "string" &&
    typeof e.timestamp === "number" &&
    typeof e.signature === "string" &&
    "payload" in e
  );
}

/**
 * Verify an envelope and hand back its payload.
 *
 * Checks shape, signature, and clock skew. It does NOT check the nonce against
 * anything — duplicate detection needs state, so it lives in the server's
 * replay guard, not here.
 */
export function open<P extends CanonicalValue = CanonicalValue>(
  value: unknown,
  now: number = Date.now(),
  windowMs: number = REPLAY_WINDOW_MS,
): OpenResult<P> {
  if (!isEnvelope(value)) return { ok: false, reason: "malformed" };
  if (!isPublicKeyHex(value.pubkey) || !isSignatureHex(value.signature)) {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isSafeInteger(value.timestamp)) {
    return { ok: false, reason: "malformed" };
  }

  const age = now - value.timestamp;
  if (age > windowMs) return { ok: false, reason: "stale-timestamp" };
  if (age < -windowMs) return { ok: false, reason: "future-timestamp" };

  let bytes: Uint8Array;
  try {
    bytes = canonicalBytes(
      signingBody(value.payload, value.pubkey, value.nonce, value.timestamp),
    );
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!verifyBytes(bytes, value.signature, value.pubkey)) {
    return { ok: false, reason: "bad-signature" };
  }

  return {
    ok: true,
    payload: value.payload as P,
    pubkey: value.pubkey,
    nonce: value.nonce,
  };
}
