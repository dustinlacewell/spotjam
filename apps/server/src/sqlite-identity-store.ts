// SQLite-backed identity store.
//
// Durability is the whole point: a restart must not hand someone else your
// name. node:sqlite ships with Node 22+, so this costs no dependency.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeUsername, type IdentityRecord, type PublicKeyHex } from "@spotjam/protocol";

import {
  decideRegistration,
  type IdentityStore,
  type RegisterResult,
} from "./identity-store.ts";

export const DEFAULT_DB_PATH = "./data/spotjam.db";

/** Where the database lives, per environment. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SPOTJAM_DB;
  return configured !== undefined && configured !== "" ? configured : DEFAULT_DB_PATH;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS identities (
    pubkey              TEXT PRIMARY KEY,
    username            TEXT NOT NULL,
    normalized_username TEXT NOT NULL UNIQUE,
    created_at_epoch_ms INTEGER NOT NULL
  );
`;

/** One row as stored. Column names are snake_case; the domain type is not. */
interface IdentityRow {
  pubkey: string;
  username: string;
  normalized_username: string;
  created_at_epoch_ms: number;
}

function toRecord(row: IdentityRow): IdentityRecord {
  return {
    pubkey: row.pubkey,
    username: row.username,
    normalizedUsername: row.normalized_username,
    createdAtEpochMs: Number(row.created_at_epoch_ms),
  };
}

export class SqliteIdentityStore implements IdentityStore {
  readonly #db: DatabaseSync;

  constructor(path: string = resolveDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
  }

  register(pubkey: PublicKeyHex, username: string, now: number): RegisterResult {
    const decision = decideRegistration(
      pubkey,
      username,
      now,
      this.lookupByPubkey(pubkey),
      this.lookupByUsername(normalizeUsername(username)),
    );
    if (!decision.ok) return decision;

    const { record } = decision;
    this.#db
      .prepare(
        `INSERT INTO identities (pubkey, username, normalized_username, created_at_epoch_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pubkey) DO NOTHING`,
      )
      .run(record.pubkey, record.username, record.normalizedUsername, record.createdAtEpochMs);

    return decision;
  }

  lookupByPubkey(pubkey: PublicKeyHex): IdentityRecord | null {
    const row = this.#db
      .prepare(`SELECT * FROM identities WHERE pubkey = ?`)
      .get(pubkey) as IdentityRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  lookupByUsername(normalized: string): IdentityRecord | null {
    const row = this.#db
      .prepare(`SELECT * FROM identities WHERE normalized_username = ?`)
      .get(normalized) as IdentityRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  close(): void {
    this.#db.close();
  }
}
