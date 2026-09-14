// Registration — binding a username to a public key.
//
// The key is the identity; the username is a label the server maps to it. The
// server stores the pair so other people see a name rather than hex. Because
// registration arrives in a signed envelope, proving ownership of the key is
// automatic — there is no password and nothing to reset.

import type { PublicKeyHex } from "./identity.js";

/** Claim a username for the envelope's public key. */
export interface RegisterPayload {
  type: "register";
  username: string;
}

/** Present an existing identity. The signature is the proof. */
export interface HelloPayload {
  type: "hello";
}

export type AuthPayload = RegisterPayload | HelloPayload;

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 24;

/** Letters, digits, underscore and hyphen; must start with a letter or digit. */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN &&
    value.length <= USERNAME_MAX &&
    USERNAME_RE.test(value)
  );
}

/** Case-insensitive uniqueness: the form stored for collision checks. */
export function normalizeUsername(value: string): string {
  return value.toLowerCase();
}

/** A registered identity as the server stores it. */
export interface IdentityRecord {
  pubkey: PublicKeyHex;
  username: string;
  normalizedUsername: string;
  createdAtEpochMs: number;
}
