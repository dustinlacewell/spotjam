// Identity — ed25519 keypairs and the encoding used on the wire.
//
// A spotjam identity is an ed25519 keypair. The public key, hex-encoded, is
// the user id: it is stable, self-issued, and needs no server to mint. The
// private key never leaves the machine that generated it.

import { ed25519 } from "@noble/curves/ed25519";

/** Hex-encoded ed25519 public key. Doubles as the user id. */
export type PublicKeyHex = string;

/** Hex-encoded ed25519 signature. */
export type SignatureHex = string;

/** A full keypair. The secret key is never transmitted. */
export interface Keypair {
  publicKey: PublicKeyHex;
  secretKey: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True when the string is a well-formed public key (32 bytes, hex). */
export function isPublicKeyHex(value: string): value is PublicKeyHex {
  return HEX_64.test(value);
}

/** True when the string is a well-formed signature (64 bytes, hex). */
export function isSignatureHex(value: string): value is SignatureHex {
  return HEX_128.test(value);
}

/** Generate a fresh identity. */
export function generateKeypair(): Keypair {
  const secret = ed25519.utils.randomPrivateKey();
  return {
    secretKey: toHex(secret),
    publicKey: toHex(ed25519.getPublicKey(secret)),
  };
}

/** Derive the public key of an existing secret key. */
export function publicKeyOf(secretKeyHex: string): PublicKeyHex {
  return toHex(ed25519.getPublicKey(fromHex(secretKeyHex)));
}

/** Sign raw bytes. Callers should sign a canonical encoding, not free text. */
export function signBytes(bytes: Uint8Array, secretKeyHex: string): SignatureHex {
  return toHex(ed25519.sign(bytes, fromHex(secretKeyHex)));
}

/** Verify raw bytes against a signature and public key. Never throws. */
export function verifyBytes(
  bytes: Uint8Array,
  signatureHex: SignatureHex,
  publicKeyHex: PublicKeyHex,
): boolean {
  if (!isSignatureHex(signatureHex) || !isPublicKeyHex(publicKeyHex)) return false;
  try {
    return ed25519.verify(fromHex(signatureHex), bytes, fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

/** A short, human-readable form of a public key, for logs and debugging. */
export function shortKey(publicKeyHex: PublicKeyHex): string {
  return publicKeyHex.slice(0, 8);
}
