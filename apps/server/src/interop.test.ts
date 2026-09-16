// Interop — the client's signed envelopes against a real listening server.
//
// The desktop client signs in Rust, but the signing body is the protocol's
// own: canonical bytes of {nonce, payload, pubkey, timestamp}. So `seal` here
// produces exactly the frames the client puts on the wire, and what this file
// proves about them holds for the real client.
//
// Two halves: the happy path a client actually walks, and the adversarial one
// a captured or forged frame walks. The second half matters more — a server
// that accepts a forgery is worse than one that accepts nothing.

import {
  canonicalBytes,
  generateKeypair,
  seal,
  signBytes,
  NULL_POINTER,
  REPLAY_WINDOW_MS,
  type CanonicalValue,
  type Envelope,
  type ErrorEvent,
  type Keypair,
  type RoomSnapshot,
  type ServerEvent,
} from "@spotjam/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { MemoryIdentityStore } from "./identity-store.ts";
import { startServer, type RunningServer } from "./server.ts";

let running: RunningServer | null = null;
const opened: Client[] = [];

// A failed assertion must not leave a socket or a listener behind, or the
// whole run hangs on the one broken test.
afterEach(async () => {
  for (const client of opened) client.close();
  opened.length = 0;
  await running?.close();
  running = null;
});

/** Listen on an ephemeral port so parallel runs cannot collide. */
async function start(): Promise<RunningServer> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    identities: new MemoryIdentityStore(),
  });
  return running;
}

// ---------------------------------------------------------------------------
// Client — a socket that queues events so a test can await the next one
// ---------------------------------------------------------------------------

class Client {
  readonly #socket: WebSocket;
  readonly #pending: ServerEvent[] = [];
  #waiter: ((event: ServerEvent) => void) | null = null;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const waiter = this.#waiter;
      if (waiter !== null) {
        this.#waiter = null;
        waiter(event);
        return;
      }
      this.#pending.push(event);
    });
  }

  static async connect(port: number): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const client = new Client(socket);
    opened.push(client);
    return client;
  }

  /** Seal and send, as the desktop client does. */
  send(payload: CanonicalValue, identity: Keypair, now?: number): void {
    this.#socket.send(JSON.stringify(seal(payload, identity, now ?? Date.now())));
  }

  /** Send a pre-built envelope verbatim — forgeries and replays need this. */
  sendEnvelope(envelope: Envelope): void {
    this.#socket.send(JSON.stringify(envelope));
  }

  /** Send raw bytes, bypassing every protocol guarantee. */
  sendRaw(frame: string): void {
    this.#socket.send(frame);
  }

  next(timeoutMs = 2_000): Promise<ServerEvent> {
    const queued = this.#pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error("timed out waiting for a server event"));
      }, timeoutMs);

      this.#waiter = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
  }

  /** Nothing arrived within the grace period. Proves silence, not just delay. */
  async expectSilence(graceMs = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    if (this.#pending.length > 0) {
      throw new Error(`expected silence, got ${JSON.stringify(this.#pending)}`);
    }
  }

  close(): void {
    this.#socket.close();
  }

  /** Resolves once the server has observed this socket going away. */
  async closeAndSettle(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.#socket.once("close", () => resolve()));
    this.#socket.close();
    await closed;
  }
}

// ---------------------------------------------------------------------------
// Narrowing helpers — a test says what it proves, these say how
// ---------------------------------------------------------------------------

function expectRoomState(event: ServerEvent): RoomSnapshot {
  if (event.type !== "room-state") {
    throw new Error(`expected room-state, got ${event.type}: ${JSON.stringify(event)}`);
  }
  return event.snapshot;
}

function expectError(event: ServerEvent): ErrorEvent {
  if (event.type !== "error") {
    throw new Error(`expected error, got ${event.type}: ${JSON.stringify(event)}`);
  }
  return event;
}

/** Register a fresh identity and wait for the server to confirm it. */
async function registerAs(client: Client, identity: Keypair, username: string): Promise<void> {
  client.send({ type: "register", username }, identity);
  const event = await client.next();
  if (event.type !== "registered") {
    throw new Error(`registration failed: ${JSON.stringify(event)}`);
  }
}

/** Join a room and return the snapshot that comes back. */
async function joinRoom(
  client: Client,
  identity: Keypair,
  roomId: string,
): Promise<RoomSnapshot> {
  client.send({ type: "join-room", roomId }, identity);
  return expectRoomState(await client.next());
}

/**
 * A queue item as a signable value.
 *
 * Not annotated `QueueItem`: an interface has no implicit index signature, so
 * it is not assignable to `CanonicalValue`. The shape is the same one the
 * wire carries — this only keeps it signable.
 */
function track(id: string): { [key: string]: CanonicalValue } {
  return { id, uri: `spotify:track:${id}`, trackId: id, durationMs: 200_000 };
}

function ids(snapshot: RoomSnapshot): string[] {
  return snapshot.sessionQueue.map((entry) => entry.item.id);
}

/** Poll until the predicate holds, rather than sleeping a guessed interval. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

// ---------------------------------------------------------------------------
// Forgery — built by hand, because `seal` cannot express these
// ---------------------------------------------------------------------------

/**
 * An envelope signed by `signer` but claiming `claimedPubkey` as its author.
 *
 * This is the attack the whole signature scheme exists to stop: a real key
 * proving a real signature over a body that names somebody else.
 */
function forgeWrongAuthor(
  payload: CanonicalValue,
  signer: Keypair,
  claimedPubkey: string,
  now = Date.now(),
): Envelope {
  const nonce = "f0".repeat(16);
  const body = { nonce, payload, pubkey: claimedPubkey, timestamp: now };
  return {
    payload,
    pubkey: claimedPubkey,
    nonce,
    timestamp: now,
    signature: signBytes(canonicalBytes(body), signer.secretKey),
  };
}

/** A correctly signed envelope whose payload was edited afterwards. */
function tamperPayload(envelope: Envelope, replacement: CanonicalValue): Envelope {
  return { ...envelope, payload: replacement };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("interop — a signed client against a real server", () => {
  it("registers an identity, then greets it again on a second connection", async () => {
    const server = await start();
    const alice = generateKeypair();

    const first = await Client.connect(server.port);
    first.send({ type: "register", username: "alice" }, alice);
    expect(await first.next()).toMatchObject({
      type: "registered",
      pubkey: alice.publicKey,
      username: "alice",
    });

    // The key is the identity: a second socket proves it with a signature
    // alone, no password and nothing stored client-side but the key.
    const second = await Client.connect(server.port);
    second.send({ type: "hello" }, alice);
    expect(await second.next()).toMatchObject({
      type: "registered",
      pubkey: alice.publicKey,
      username: "alice",
    });
  });

  it("joins a room, enqueues, and broadcasts the tracks into the session queue", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");

    const joined = await joinRoom(client, alice, "jam");
    expect(joined.roomId).toBe("jam");
    expect(joined.participants).toHaveLength(1);
    expect(joined.myQueue).toEqual([]);
    expect(joined.pointer).toEqual(NULL_POINTER);

    client.send({ type: "enqueue", roomId: "jam", items: [track("a1"), track("a2")] }, alice);
    const enqueued = expectRoomState(await client.next());
    expect(enqueued.myQueue.map((item) => item.id)).toEqual(["a1", "a2"]);
    // Not broadcasting yet, so the room has no audio source and no play order.
    expect(enqueued.sessionQueue).toEqual([]);

    client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    const live = expectRoomState(await client.next());
    // Broadcasting with tracks queued starts playback: a1 is playing, so the
    // session queue holds only what is still waiting.
    expect(live.pointer.itemId).toBe("a1");
    expect(ids(live)).toEqual(["a2"]);
    expect(live.participants[0]?.broadcasting).toBe(true);
  });

  it("interleaves two broadcasters round-robin", async () => {
    const server = await start();
    const alice = generateKeypair();
    const bob = generateKeypair();

    const clientA = await Client.connect(server.port);
    const clientB = await Client.connect(server.port);
    await registerAs(clientA, alice, "alice");
    await registerAs(clientB, bob, "bob");

    await joinRoom(clientA, alice, "jam");
    await joinRoom(clientB, bob, "jam");
    await clientA.next(); // Bob's join reaches Alice too.

    clientA.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await clientA.next();
    await clientB.next();
    clientB.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, bob);
    await clientA.next();
    await clientB.next();

    clientA.send(
      { type: "enqueue", roomId: "jam", items: [track("a1"), track("a2")] },
      alice,
    );
    await clientA.next();
    await clientB.next();
    clientB.send(
      { type: "enqueue", roomId: "jam", items: [track("b1"), track("b2")] },
      bob,
    );
    await clientA.next();

    // Alice's enqueue started a1 at once, so a1 is playing rather than queued.
    // The rest still interleaves: everyone's next track, then the one after.
    const snapshot = expectRoomState(await clientB.next());
    expect(snapshot.pointer.itemId).toBe("a1");
    expect(ids(snapshot)).toEqual(["b1", "a2", "b2"]);
  });

  it("gives one identity a single turn even across two connections", async () => {
    const server = await start();
    const alice = generateKeypair();
    const bob = generateKeypair();

    const aliceOne = await Client.connect(server.port);
    const aliceTwo = await Client.connect(server.port);
    const clientB = await Client.connect(server.port);

    await registerAs(aliceOne, alice, "alice");
    aliceTwo.send({ type: "hello" }, alice);
    await aliceTwo.next();
    await registerAs(clientB, bob, "bob");

    // The same key arrives on two sockets. Turn order is keyed by identity,
    // so this must not buy Alice a second slot in the rotation.
    await joinRoom(aliceOne, alice, "jam");
    await joinRoom(aliceTwo, alice, "jam");
    await aliceOne.next();
    await joinRoom(clientB, bob, "jam");
    await aliceOne.next();
    await aliceTwo.next();

    for (const [client, identity] of [
      [aliceOne, alice],
      [clientB, bob],
    ] as const) {
      client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, identity);
      await aliceOne.next();
      await aliceTwo.next();
      await clientB.next();
    }

    aliceOne.send({ type: "enqueue", roomId: "jam", items: [track("a1"), track("a2")] }, alice);
    await aliceOne.next();
    await aliceTwo.next();
    await clientB.next();
    clientB.send({ type: "enqueue", roomId: "jam", items: [track("b1"), track("b2")] }, bob);
    await aliceOne.next();
    await aliceTwo.next();

    const snapshot = expectRoomState(await clientB.next());
    expect(snapshot.participants).toHaveLength(2);
    // Alice's enqueue started a1 at once, so it is playing rather than queued.
    expect(snapshot.pointer.itemId).toBe("a1");
    expect(ids(snapshot)).toEqual(["b1", "a2", "b2"]);
    // The giveaway for a dedupe bug would be Alice getting two slots per round.
    expect(ids(snapshot).filter((id) => id.startsWith("a"))).toEqual(["a2"]);
  });

  it("discards a room when its last participant disconnects", async () => {
    const server = await start();
    const alice = generateKeypair();

    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");

    client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await client.next();
    client.send({ type: "enqueue", roomId: "jam", items: [track("a1"), track("a2")] }, alice);
    // Alice is already broadcasting, so a1 starts playing and a2 waits.
    const enqueued = expectRoomState(await client.next());
    expect(enqueued.pointer.itemId).toBe("a1");
    expect(ids(enqueued)).toEqual(["a2"]);

    expect(server.rooms.has("jam")).toBe(true);

    await client.closeAndSettle();
    await waitFor(() => !server.rooms.has("jam"));
    expect(server.rooms.ids()).toEqual([]);

    // The real proof is not the registry bookkeeping but what the next person
    // to use the id actually sees: an empty room, not Alice's leftovers.
    const bob = generateKeypair();
    const clientB = await Client.connect(server.port);
    await registerAs(clientB, bob, "bob");

    const fresh = await joinRoom(clientB, bob, "jam");
    expect(fresh.participants.map((p) => p.username)).toEqual(["bob"]);
    expect(fresh.sessionQueue).toEqual([]);
    expect(fresh.myQueue).toEqual([]);
    expect(fresh.pointer).toEqual(NULL_POINTER);
  });

  it("keeps a room alive while a second connection holds the same identity", async () => {
    const server = await start();
    const alice = generateKeypair();

    const first = await Client.connect(server.port);
    const second = await Client.connect(server.port);
    await registerAs(first, alice, "alice");
    second.send({ type: "hello" }, alice);
    await second.next();

    await joinRoom(first, alice, "jam");
    await joinRoom(second, alice, "jam");
    await first.next();

    // One socket of two going away is not the identity leaving.
    await first.closeAndSettle();
    const stillThere = expectRoomState(await second.next());
    expect(stillThere.participants.map((p) => p.username)).toEqual(["alice"]);
    expect(server.rooms.has("jam")).toBe(true);

    await second.closeAndSettle();
    await waitFor(() => !server.rooms.has("jam"));
  });

  it("clears the pointer when the last broadcaster stops", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");

    client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await client.next();
    // Alice is already broadcasting, so the enqueue itself starts playback.
    client.send({ type: "enqueue", roomId: "jam", items: [track("a1")] }, alice);
    const playing = expectRoomState(await client.next());
    expect(playing.pointer.itemId).toBe("a1");
    expect(playing.pointer.ownerPubkey).toBe(alice.publicKey);

    // Playback belongs to the broadcasters; with none, the room must not keep
    // pointing at a track.
    client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: false }, alice);
    expect(expectRoomState(await client.next()).pointer).toEqual(NULL_POINTER);
  });

  it("carries the track's duration in the pointer", async () => {
    // The whole room reads position off the pointer, so the duration has to
    // survive the wire rather than be looked up somewhere.
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);

    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");
    client.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await client.next();
    client.send({ type: "enqueue", roomId: "jam", items: [track("a1")] }, alice);

    const playing = expectRoomState(await client.next());
    expect(playing.pointer).toMatchObject({ itemId: "a1", durationMs: 200_000 });
  });

  it("refuses a queued track with no duration", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);

    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");
    client.send(
      {
        type: "enqueue",
        roomId: "jam",
        items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1" }],
      },
      alice,
    );

    expect(await client.next()).toMatchObject({ type: "error", code: "malformed" });
  });

  it("clears the pointer when the broadcaster leaves the room", async () => {
    const server = await start();
    const alice = generateKeypair();
    const bob = generateKeypair();

    const clientA = await Client.connect(server.port);
    const clientB = await Client.connect(server.port);
    await registerAs(clientA, alice, "alice");
    await registerAs(clientB, bob, "bob");
    await joinRoom(clientA, alice, "jam");
    await joinRoom(clientB, bob, "jam");
    await clientA.next();

    clientA.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await clientA.next();
    await clientB.next();
    // Alice is already broadcasting, so the enqueue itself starts playback.
    clientA.send({ type: "enqueue", roomId: "jam", items: [track("a1")] }, alice);
    expect(expectRoomState(await clientA.next()).pointer.itemId).toBe("a1");
    await clientB.next();

    // Bob stays, so the room survives — but its only audio source is gone.
    clientA.send({ type: "leave-room", roomId: "jam" }, alice);
    const bobsView = expectRoomState(await clientB.next());
    expect(bobsView.participants.map((p) => p.username)).toEqual(["bob"]);
    expect(bobsView.pointer).toEqual(NULL_POINTER);
    expect(bobsView.sessionQueue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial path
// ---------------------------------------------------------------------------

describe("interop — forged, replayed and malformed frames", () => {
  it("rejects an envelope signed by one key but claiming another", async () => {
    const server = await start();
    const alice = generateKeypair();
    const mallory = generateKeypair();

    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");

    // Mallory signs, but the envelope names Alice. The signature is real and
    // verifies against Mallory's key — never against the one it claims.
    const forged = forgeWrongAuthor(
      { type: "enqueue", roomId: "jam", items: [track("evil")] },
      mallory,
      alice.publicKey,
    );
    client.sendEnvelope(forged);
    expect(expectError(await client.next()).code).toBe("bad-signature");

    // And the queue it aimed at is untouched.
    client.send({ type: "join-room", roomId: "jam" }, alice);
    expect(expectRoomState(await client.next()).myQueue).toEqual([]);
  });

  it("rejects an envelope whose payload was edited after signing", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");

    const honest = seal<CanonicalValue>(
      { type: "enqueue", roomId: "jam", items: [track("a1")] },
      alice,
    );
    client.sendEnvelope(
      tamperPayload(honest, { type: "enqueue", roomId: "jam", items: [track("swapped")] }),
    );
    expect(expectError(await client.next()).code).toBe("bad-signature");

    client.send({ type: "join-room", roomId: "jam" }, alice);
    expect(expectRoomState(await client.next()).myQueue).toEqual([]);
  });

  it("rejects a byte-identical replay of an envelope it already accepted", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");
    await joinRoom(client, alice, "jam");

    const envelope = seal<CanonicalValue>(
      { type: "enqueue", roomId: "jam", items: [track("a1")] },
      alice,
    );

    client.sendEnvelope(envelope);
    expect(expectRoomState(await client.next()).myQueue.map((i) => i.id)).toEqual(["a1"]);

    // Same bytes again. The signature still verifies — the nonce is what
    // stops it, and it must, or a captured frame is a free replay.
    client.sendEnvelope(envelope);
    expect(expectError(await client.next()).code).toBe("replay");

    client.send({ type: "join-room", roomId: "jam" }, alice);
    expect(expectRoomState(await client.next()).myQueue.map((i) => i.id)).toEqual(["a1"]);
  });

  it("rejects a stale envelope", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");

    const twoMinutesAgo = Date.now() - 120_000;
    client.send({ type: "join-room", roomId: "jam" }, alice, twoMinutesAgo);
    expect(expectError(await client.next()).code).toBe("stale-envelope");

    // The window is a minute, so 2 minutes is well past it; pin the real
    // boundary too, or this test would still pass with the window widened.
    client.send({ type: "join-room", roomId: "jam" }, alice, Date.now() - REPLAY_WINDOW_MS - 5_000);
    expect(expectError(await client.next()).code).toBe("stale-envelope");
  });

  it("rejects an envelope dated far in the future", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");

    client.send({ type: "join-room", roomId: "jam" }, alice, Date.now() + 120_000);
    expect(expectError(await client.next()).code).toBe("stale-envelope");
  });

  it("leaves another identity's queue untouched by remove, move and clear", async () => {
    const server = await start();
    const alice = generateKeypair();
    const mallory = generateKeypair();

    const clientA = await Client.connect(server.port);
    const clientM = await Client.connect(server.port);
    await registerAs(clientA, alice, "alice");
    await registerAs(clientM, mallory, "mallory");
    await joinRoom(clientA, alice, "jam");
    await joinRoom(clientM, mallory, "jam");
    await clientA.next();

    clientA.send(
      { type: "enqueue", roomId: "jam", items: [track("a1"), track("a2"), track("a3")] },
      alice,
    );
    expect(expectRoomState(await clientA.next()).myQueue.map((i) => i.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    await clientM.next();

    // An op carries no author field — the envelope's key is the author — so
    // the worst Mallory can do is operate on her own empty queue.
    for (const op of [
      { type: "remove", roomId: "jam", itemId: "a1" },
      { type: "move-many", roomId: "jam", itemIds: ["a1"], beforeItemId: null },
      { type: "send-to-top", roomId: "jam", itemId: "a3" },
      { type: "clear-queue", roomId: "jam" },
    ] satisfies CanonicalValue[]) {
      clientM.send(op, mallory);
      // Whatever comes back, Mallory's queue is the only one in reach.
      const seen = await clientM.next();
      if (seen.type === "room-state") expect(seen.snapshot.myQueue).toEqual([]);
      await clientA.next();
    }

    clientA.send({ type: "join-room", roomId: "jam" }, alice);
    const alicesQueue = expectRoomState(await clientA.next()).myQueue.map((i) => i.id);
    expect(alicesQueue).toEqual(["a1", "a2", "a3"]);
  });

  it("refuses ops from a socket that has not authenticated", async () => {
    const server = await start();
    const stranger = generateKeypair();
    const client = await Client.connect(server.port);

    // A perfectly valid signature over a perfectly valid op — from a key the
    // server has never been introduced to.
    client.send({ type: "join-room", roomId: "jam" }, stranger);
    expect(expectError(await client.next()).code).toBe("unknown-identity");
    expect(server.rooms.ids()).toEqual([]);
  });

  it("refuses an op signed by a key other than the one this socket proved", async () => {
    const server = await start();
    const alice = generateKeypair();
    const bob = generateKeypair();

    const client = await Client.connect(server.port);
    await registerAs(client, alice, "alice");

    const other = await Client.connect(server.port);
    await registerAs(other, bob, "bob");

    // Alice's socket, Bob's signature. Both keys are known to the server; the
    // mismatch with the session is the problem.
    client.send({ type: "join-room", roomId: "jam" }, bob);
    expect(expectError(await client.next()).code).toBe("unknown-identity");
  });

  it("refuses a username already taken by another key", async () => {
    const server = await start();
    const alice = generateKeypair();
    const impostor = generateKeypair();

    const clientA = await Client.connect(server.port);
    await registerAs(clientA, alice, "alice");

    const clientB = await Client.connect(server.port);
    clientB.send({ type: "register", username: "alice" }, impostor);
    expect(expectError(await clientB.next()).code).toBe("username-taken");

    // Case-folded, so a near-miss is refused too.
    clientB.send({ type: "register", username: "ALICE" }, impostor);
    expect(expectError(await clientB.next()).code).toBe("username-taken");
  });

  it("accepts a key re-registering the name it already owns", async () => {
    const server = await start();
    const alice = generateKeypair();
    const client = await Client.connect(server.port);

    await registerAs(client, alice, "alice");
    // A client that re-sends register after a reconnect must not be broken
    // by its own idempotence.
    client.send({ type: "register", username: "alice" }, alice);
    expect(await client.next()).toMatchObject({ type: "registered", username: "alice" });
  });

  it("refuses malformed usernames", async () => {
    const server = await start();
    const client = await Client.connect(server.port);

    for (const username of ["a", "", "_alice", "has space", "-dash", "a".repeat(25), "bad!"]) {
      client.send({ type: "register", username }, generateKeypair());
      const event = await client.next();
      expect(
        { username, code: expectError(event).code },
        `username ${JSON.stringify(username)}`,
      ).toEqual({ username, code: "invalid-username" });
    }
  });

  it("answers garbage frames with a typed error and stays alive", async () => {
    const server = await start();
    const alice = generateKeypair();
    const victim = await Client.connect(server.port);
    await registerAs(victim, alice, "alice");
    await joinRoom(victim, alice, "jam");

    const attacker = await Client.connect(server.port);

    // Not JSON at all.
    attacker.sendRaw("}{ not json");
    expect(expectError(await attacker.next()).code).toBe("malformed");

    // JSON, but nothing like an envelope.
    for (const frame of ["[]", "null", "42", '"a string"', '{"hello":"world"}']) {
      attacker.sendRaw(frame);
      expect(expectError(await attacker.next()).code).toBe("malformed");
    }

    // Envelope-shaped, but the fields are the wrong types or lengths.
    attacker.sendRaw(
      JSON.stringify({
        payload: { type: "hello" },
        pubkey: "not-hex",
        nonce: "n",
        timestamp: Date.now(),
        signature: "also-not-hex",
      }),
    );
    expect(expectError(await attacker.next()).code).toBe("malformed");

    // A properly signed envelope whose payload is neither auth nor an op.
    attacker.send({ type: "definitely-not-an-op", roomId: "jam" }, generateKeypair());
    expect(expectError(await attacker.next()).code).toBe("malformed");

    // A payload that is not an object at all.
    attacker.send("just a string", generateKeypair());
    expect(expectError(await attacker.next()).code).toBe("malformed");

    // None of that reached the room.
    await victim.expectSilence();

    // The process is still serving: a real op on another socket still works.
    victim.send({ type: "enqueue", roomId: "jam", items: [track("a1")] }, alice);
    expect(expectRoomState(await victim.next()).myQueue.map((i) => i.id)).toEqual(["a1"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  });
});
