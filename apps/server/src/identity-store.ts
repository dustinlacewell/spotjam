// Identity store — the durable map from public key to username.
//
// The key is the identity; this store only decides which label belongs to it.
// Two people may not share a name, case-folded, and a key keeps the name it
// first claimed.

import {
  isValidUsername,
  normalizeUsername,
  type IdentityRecord,
  type PublicKeyHex,
} from "@spotjam/protocol";

/** Why a registration did not take, or the record it produced. */
export type RegisterResult =
  | { ok: true; record: IdentityRecord }
  | { ok: false; reason: "username-taken" | "invalid-username" };

/**
 * The seam in front of persistence.
 *
 * The server depends on this, never on SQLite, so tests run against an
 * in-memory implementation with no file on disk.
 */
export interface IdentityStore {
  register(pubkey: PublicKeyHex, username: string, now: number): RegisterResult;
  lookupByPubkey(pubkey: PublicKeyHex): IdentityRecord | null;
  lookupByUsername(normalized: string): IdentityRecord | null;
  close(): void;
}

/**
 * Decide a registration against whatever the store already holds.
 *
 * Pure: the two implementations share it so their rules cannot drift apart.
 * Re-registering the name a key already owns succeeds and is a no-op, which
 * keeps a client that re-sends `register` after a reconnect from erroring.
 */
export function decideRegistration(
  pubkey: PublicKeyHex,
  username: string,
  now: number,
  existingForPubkey: IdentityRecord | null,
  existingForName: IdentityRecord | null,
): RegisterResult {
  if (!isValidUsername(username)) return { ok: false, reason: "invalid-username" };

  const normalized = normalizeUsername(username);

  if (existingForName !== null && existingForName.pubkey !== pubkey) {
    return { ok: false, reason: "username-taken" };
  }

  if (existingForPubkey !== null) {
    // A key keeps its first name. Asking again for the same name is fine;
    // asking for a different one is refused as taken by nobody else but itself.
    if (existingForPubkey.normalizedUsername === normalized) {
      return { ok: true, record: existingForPubkey };
    }
    return { ok: false, reason: "username-taken" };
  }

  return {
    ok: true,
    record: { pubkey, username, normalizedUsername: normalized, createdAtEpochMs: now },
  };
}

/** Volatile store. The test substitute, and a usable fallback. */
export class MemoryIdentityStore implements IdentityStore {
  readonly #byPubkey = new Map<PublicKeyHex, IdentityRecord>();
  readonly #byName = new Map<string, IdentityRecord>();

  register(pubkey: PublicKeyHex, username: string, now: number): RegisterResult {
    const decision = decideRegistration(
      pubkey,
      username,
      now,
      this.lookupByPubkey(pubkey),
      this.lookupByUsername(normalizeUsername(username)),
    );
    if (decision.ok) {
      this.#byPubkey.set(decision.record.pubkey, decision.record);
      this.#byName.set(decision.record.normalizedUsername, decision.record);
    }
    return decision;
  }

  lookupByPubkey(pubkey: PublicKeyHex): IdentityRecord | null {
    return this.#byPubkey.get(pubkey) ?? null;
  }

  lookupByUsername(normalized: string): IdentityRecord | null {
    return this.#byName.get(normalized) ?? null;
  }

  close(): void {
    // Nothing to release.
  }
}
