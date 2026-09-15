// Manifest store — the durable home of the updater document.
//
// There is exactly one manifest, so this is a single-row store. The seam
// exists for the same reason IdentityStore's does: the server depends on the
// interface, never on SQLite, so tests run with no file on disk.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ReleaseManifest } from "./release-manifest.ts";

/** The seam in front of persistence. */
export interface ManifestStore {
  load(): ReleaseManifest | null;
  save(manifest: ReleaseManifest): void;
  close(): void;
}

/** Volatile store. The test substitute. */
export class MemoryManifestStore implements ManifestStore {
  #manifest: ReleaseManifest | null = null;

  constructor(initial: ReleaseManifest | null = null) {
    this.#manifest = initial;
  }

  load(): ReleaseManifest | null {
    return this.#manifest;
  }

  save(manifest: ReleaseManifest): void {
    this.#manifest = manifest;
  }

  close(): void {
    // Nothing to release.
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS release_manifest (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    document TEXT NOT NULL
  );
`;

/**
 * SQLite-backed store, sharing the identity store's database file.
 *
 * A release survives a container restart; re-deriving it would mean asking
 * GitHub, which is the round trip this design exists to avoid.
 */
export class SqliteManifestStore implements ManifestStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
  }

  load(): ReleaseManifest | null {
    const row = this.#db.prepare(`SELECT document FROM release_manifest WHERE id = 1`).get() as
      | { document: string }
      | undefined;
    if (row === undefined) return null;

    try {
      return JSON.parse(row.document) as ReleaseManifest;
    } catch {
      // A corrupt row is not worth taking the server down for; the next post
      // overwrites it.
      return null;
    }
  }

  save(manifest: ReleaseManifest): void {
    this.#db
      .prepare(
        `INSERT INTO release_manifest (id, document) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET document = excluded.document`,
      )
      .run(JSON.stringify(manifest));
  }

  close(): void {
    this.#db.close();
  }
}
