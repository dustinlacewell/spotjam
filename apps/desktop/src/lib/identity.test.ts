import { describe, expect, it } from "vitest";

import { fromHex } from "./testing";
import {
  canonicalBytes,
  generateKeypair,
  isValidUsername,
  normalizeUsername,
  open,
  signBytes,
  USERNAME_MAX,
  USERNAME_MIN,
  type Keypair,
} from "@spotjam/protocol";
import { IdentityClient, envelopeFrom, signingBody } from "./identity";

const EPOCH = 1_700_000_000_000;

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

/**
 * Stands in for the Rust side: holds a keypair, signs what it is given, and
 * records every command. Signing here with the protocol's own `signBytes` is
 * what lets the envelope tests round-trip through `open()`.
 */
function makeInvoke(options: { stored?: Keypair; username?: string } = {}) {
  const calls: Call[] = [];
  let stored = options.stored ?? null;
  let username = options.username ?? "alice";

  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "identity_load":
        return (stored?.publicKey ?? null) as T;
      case "identity_username":
        return (stored ? username : null) as T;
      case "identity_create":
        stored = generateKeypair();
        username = args?.username as string;
        return stored.publicKey as T;
      case "identity_import":
        stored = generateKeypair();
        username = "imported";
        return stored.publicKey as T;
      case "identity_export_path":
        return "C:\\Users\\x\\AppData\\Roaming\\spotjam\\identity.json" as T;
      case "identity_sign": {
        if (!stored) throw new Error("no identity on this machine");
        const messageHex = args?.messageHex as string;
        return signBytes(fromHex(messageHex), stored.secretKey) as T;
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };

  return {
    calls,
    invoke,
    names: () => calls.map((call) => call.cmd),
    of: (cmd: string) => calls.filter((call) => call.cmd === cmd),
    publicKey: () => stored?.publicKey ?? null,
  };
}

describe("IdentityClient", () => {
  describe("load", () => {
    it("returns null when the machine has no identity", async () => {
      const fake = makeInvoke();
      expect(await new IdentityClient(fake.invoke).load()).toBeNull();
    });

    it("returns the stored key and username", async () => {
      const stored = generateKeypair();
      const fake = makeInvoke({ stored, username: "bob" });

      expect(await new IdentityClient(fake.invoke).load()).toEqual({
        publicKey: stored.publicKey,
        username: "bob",
      });
    });

    it("does not ask for the username when there is no identity", async () => {
      const fake = makeInvoke();
      await new IdentityClient(fake.invoke).load();
      expect(fake.names()).toEqual(["identity_load"]);
    });
  });

  describe("create", () => {
    it("stores a keypair and reports the public key", async () => {
      const fake = makeInvoke();
      const identity = await new IdentityClient(fake.invoke).create("alice");

      expect(identity.username).toBe("alice");
      expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.of("identity_create")[0].args).toEqual({ username: "alice" });
    });
  });

  describe("import", () => {
    it("passes the path through and reports the installed key", async () => {
      const fake = makeInvoke();
      const identity = await new IdentityClient(fake.invoke).import("D:\\backup\\identity.json");

      expect(fake.of("identity_import")[0].args).toEqual({ path: "D:\\backup\\identity.json" });
      expect(identity.publicKey).toBe(fake.publicKey());
      expect(identity.username).toBe("imported");
    });
  });

  describe("signing", () => {
    it("sends bytes to Rust as hex", async () => {
      const fake = makeInvoke({ stored: generateKeypair() });
      await new IdentityClient(fake.invoke).signBytes(new Uint8Array([0, 1, 171, 255]));

      expect(fake.of("identity_sign")[0].args).toEqual({ messageHex: "0001abff" });
    });

    it("signs a payload's canonical bytes", async () => {
      const stored = generateKeypair();
      const fake = makeInvoke({ stored });
      const payload = { type: "hello" } as const;

      const signature = await new IdentityClient(fake.invoke).signPayload(payload);

      expect(signature).toBe(signBytes(canonicalBytes(payload), stored.secretKey));
    });

    it("fails when the machine has no identity", async () => {
      const fake = makeInvoke();
      await expect(new IdentityClient(fake.invoke).signPayload({ type: "hello" })).rejects.toThrow(
        /no identity/,
      );
    });
  });

  describe("seal", () => {
    it("produces an envelope the protocol accepts", async () => {
      const stored = generateKeypair();
      const fake = makeInvoke({ stored });

      const envelope = await new IdentityClient(fake.invoke).seal(
        { type: "register", username: "alice" },
        stored.publicKey,
        EPOCH,
      );

      const result = open(envelope, EPOCH);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pubkey).toBe(stored.publicKey);
      expect(result.payload).toEqual({ type: "register", username: "alice" });
    });

    it("signs the protocol's signing body, not the bare payload", async () => {
      const stored = generateKeypair();
      const fake = makeInvoke({ stored });

      const envelope = await new IdentityClient(fake.invoke).seal(
        { type: "hello" },
        stored.publicKey,
        EPOCH,
      );

      const expected = canonicalBytes(
        signingBody({ type: "hello" }, stored.publicKey, envelope.nonce, EPOCH),
      );
      expect(fake.of("identity_sign")[0].args).toEqual({
        messageHex: Array.from(expected)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      });
    });

    it("uses a fresh nonce for every envelope", async () => {
      const stored = generateKeypair();
      const client = new IdentityClient(makeInvoke({ stored }).invoke);

      const a = await client.seal({ type: "hello" }, stored.publicKey, EPOCH);
      const b = await client.seal({ type: "hello" }, stored.publicKey, EPOCH);

      expect(a.nonce).not.toBe(b.nonce);
      expect(a.signature).not.toBe(b.signature);
    });

    it("is rejected once the timestamp falls outside the replay window", async () => {
      const stored = generateKeypair();
      const client = new IdentityClient(makeInvoke({ stored }).invoke);

      const envelope = await client.seal({ type: "hello" }, stored.publicKey, EPOCH);

      expect(open(envelope, EPOCH + 120_000).ok).toBe(false);
    });

    it("is rejected when the payload is altered after sealing", async () => {
      const stored = generateKeypair();
      const client = new IdentityClient(makeInvoke({ stored }).invoke);

      const envelope = await client.seal(
        { type: "register", username: "alice" },
        stored.publicKey,
        EPOCH,
      );
      const tampered = { ...envelope, payload: { type: "register", username: "mallory" } };

      const result = open(tampered, EPOCH);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("bad-signature");
    });
  });
});

// Onboarding gates on these, so the edges the form must reject are pinned here.
describe("username rules", () => {
  it("accepts ordinary names", () => {
    for (const name of ["ab", "alice", "bob_1", "a-b", "9lives"]) {
      expect(isValidUsername(name)).toBe(true);
    }
  });

  it("rejects names that are too short or too long", () => {
    expect(isValidUsername("a".repeat(USERNAME_MIN - 1))).toBe(false);
    expect(isValidUsername("a".repeat(USERNAME_MIN))).toBe(true);
    expect(isValidUsername("a".repeat(USERNAME_MAX))).toBe(true);
    expect(isValidUsername("a".repeat(USERNAME_MAX + 1))).toBe(false);
  });

  it("rejects a leading separator, spaces and punctuation", () => {
    for (const name of ["_alice", "-alice", "al ice", "al.ice", "al!ce", ""]) {
      expect(isValidUsername(name)).toBe(false);
    }
  });

  it("normalizes for case-insensitive collision checks", () => {
    expect(normalizeUsername("Alice")).toBe("alice");
    expect(normalizeUsername("ALICE")).toBe(normalizeUsername("alice"));
  });
});
