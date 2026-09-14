import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryIdentityStore, type IdentityStore } from "./identity-store.ts";
import { SqliteIdentityStore } from "./sqlite-identity-store.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

// Both implementations answer to the same interface, so they take the same
// suite. A divergence between them is exactly the bug worth catching.
const implementations: ReadonlyArray<[string, () => IdentityStore]> = [
  ["MemoryIdentityStore", () => new MemoryIdentityStore()],
  ["SqliteIdentityStore", () => new SqliteIdentityStore(":memory:")],
];

for (const [name, create] of implementations) {
  describe(name, () => {
    it("registers a valid username", () => {
      const store = create();
      const result = store.register(KEY_A, "Dustin", 1000);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record).toEqual({
        pubkey: KEY_A,
        username: "Dustin",
        normalizedUsername: "dustin",
        createdAtEpochMs: 1000,
      });
      store.close();
    });

    it("refuses a name another key already holds, ignoring case", () => {
      const store = create();
      store.register(KEY_A, "Dustin", 1000);
      const result = store.register(KEY_B, "DUSTIN", 2000);

      expect(result).toEqual({ ok: false, reason: "username-taken" });
      store.close();
    });

    it("refuses malformed usernames", () => {
      const store = create();
      for (const bad of ["x", "_leading", "has space", "a".repeat(25), ""]) {
        expect(store.register(KEY_A, bad, 1000)).toEqual({
          ok: false,
          reason: "invalid-username",
        });
      }
      store.close();
    });

    it("lets a key re-register the same name", () => {
      const store = create();
      store.register(KEY_A, "Dustin", 1000);
      const again = store.register(KEY_A, "dustin", 5000);

      expect(again.ok).toBe(true);
      // The original record wins, so the creation time does not drift.
      if (again.ok) expect(again.record.createdAtEpochMs).toBe(1000);
      store.close();
    });

    it("looks a record up by key and by normalized name", () => {
      const store = create();
      store.register(KEY_A, "Dustin", 1000);

      expect(store.lookupByPubkey(KEY_A)?.username).toBe("Dustin");
      expect(store.lookupByUsername("dustin")?.pubkey).toBe(KEY_A);
      expect(store.lookupByPubkey(KEY_B)).toBeNull();
      expect(store.lookupByUsername("nobody")).toBeNull();
      store.close();
    });
  });
}

describe("SqliteIdentityStore", () => {
  it("keeps records across store instances on one database", () => {
    // :memory: is per-connection, so durability needs a real file. It goes to
    // the OS temp dir, never the repo, and is removed either way.
    const path = join(mkdtempSync(join(tmpdir(), "spotjam-")), "identities.db");
    try {
      const first = new SqliteIdentityStore(path);
      first.register(KEY_A, "Dustin", 1000);
      first.close();

      const second = new SqliteIdentityStore(path);
      expect(second.lookupByUsername("dustin")?.pubkey).toBe(KEY_A);
      second.close();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("creates the database directory when it does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "spotjam-"));
    const path = join(root, "nested", "deeper", "identities.db");
    try {
      const store = new SqliteIdentityStore(path);
      store.register(KEY_A, "Dustin", 1000);
      expect(store.lookupByPubkey(KEY_A)?.username).toBe("Dustin");
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
