import { generateKeypair, seal, type ServerEvent } from "@spotjam/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { newConnection, type Connection } from "./connections.ts";
import { MemoryIdentityStore } from "./identity-store.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { RoomRegistry } from "./rooms.ts";
import { Session } from "./session.ts";
import { FakeClock, RecordingSocket, seededRng } from "./testing.ts";

const alice = generateKeypair();
const bob = generateKeypair();

let clock: FakeClock;
let rooms: RoomRegistry;
let identities: MemoryIdentityStore;
let session: Session;

beforeEach(() => {
  clock = new FakeClock();
  rooms = new RoomRegistry();
  identities = new MemoryIdentityStore();
  session = new Session({
    rooms,
    identities,
    replay: new ReplayGuard(),
    clock,
    rng: seededRng(1),
  });
});

/** Attach a socket and hand back both halves. */
function connect(): { socket: RecordingSocket; connection: Connection } {
  const socket = new RecordingSocket();
  const connection = newConnection(socket);
  session.add(connection);
  return { socket, connection };
}

function send(connection: Connection, payload: object, identity = alice): void {
  session.receive(connection, JSON.stringify(seal(payload as never, identity, clock.now())));
}

function lastEvent(socket: RecordingSocket): ServerEvent {
  const event = socket.last<ServerEvent>();
  if (event === undefined) throw new Error("socket received nothing");
  return event;
}

describe("authentication", () => {
  it("registers a username and confirms it", () => {
    const { socket, connection } = connect();
    send(connection, { type: "register", username: "alice" });

    expect(lastEvent(socket)).toEqual({
      type: "registered",
      pubkey: alice.publicKey,
      username: "alice",
    });
  });

  it("refuses ops before authentication", () => {
    const { socket, connection } = connect();
    send(connection, { type: "join-room", roomId: "jam" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "unknown-identity" });
  });

  it("refuses hello from a key that never registered", () => {
    const { socket, connection } = connect();
    send(connection, { type: "hello" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "unknown-identity" });
  });

  it("greets a returning key on hello", () => {
    identities.register(alice.publicKey, "alice", clock.now());
    const { socket, connection } = connect();
    send(connection, { type: "hello" });

    expect(lastEvent(socket)).toMatchObject({ type: "registered", username: "alice" });
  });

  it("reports a taken username with the protocol's code", () => {
    identities.register(bob.publicKey, "alice", clock.now());
    const { socket, connection } = connect();
    send(connection, { type: "register", username: "ALICE" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "username-taken" });
  });

  it("reports an invalid username", () => {
    const { socket, connection } = connect();
    send(connection, { type: "register", username: "no spaces" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "invalid-username" });
  });
});

describe("bad input", () => {
  it("answers non-JSON with malformed rather than throwing", () => {
    const { socket, connection } = connect();
    expect(() => session.receive(connection, "{not json")).not.toThrow();
    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "malformed" });
  });

  it("rejects a tampered signature", () => {
    const { socket, connection } = connect();
    const envelope = seal({ type: "register", username: "alice" }, alice, clock.now());
    envelope.payload.username = "mallory";
    session.receive(connection, JSON.stringify(envelope));

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "bad-signature" });
  });

  it("rejects a replayed envelope", () => {
    const { socket, connection } = connect();
    const raw = JSON.stringify(seal({ type: "register", username: "alice" }, alice, clock.now()));

    session.receive(connection, raw);
    session.receive(connection, raw);

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "replay" });
  });

  it("rejects a stale envelope", () => {
    const { socket, connection } = connect();
    const raw = JSON.stringify(seal({ type: "register", username: "alice" }, alice, clock.now()));
    clock.advance(120_000);
    session.receive(connection, raw);

    expect(lastEvent(socket)).toMatchObject({
      type: "error",
      code: "stale-envelope",
    });
  });

  it("rejects a payload that is neither auth nor op", () => {
    const { socket, connection } = connect();
    send(connection, { type: "nonsense" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "malformed" });
  });
});

describe("rooms", () => {
  function authed(identity = alice, username = "alice") {
    const { socket, connection } = connect();
    send(connection, { type: "register", username }, identity);
    socket.clear();
    return { socket, connection };
  }

  it("broadcasts a snapshot on join", () => {
    const { socket, connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });

    const event = lastEvent(socket);
    expect(event.type).toBe("room-state");
    if (event.type !== "room-state") return;
    expect(event.snapshot.roomId).toBe("jam");
    expect(event.snapshot.participants).toHaveLength(1);
  });

  it("refuses an op for a room the socket is not in", () => {
    const { socket, connection } = authed();
    send(connection, { type: "clear-queue", roomId: "elsewhere" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "not-in-room" });
  });

  it("sends every member a snapshot carrying only their own queue", () => {
    const a = authed(alice, "alice");
    const b = authed(bob, "bob");
    send(a.connection, { type: "join-room", roomId: "jam" });
    send(b.connection, { type: "join-room", roomId: "jam" }, bob);
    send(a.connection, {
      type: "enqueue",
      roomId: "jam",
      items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1" }],
    });

    const toAlice = lastEvent(a.socket);
    const toBob = lastEvent(b.socket);
    if (toAlice.type !== "room-state" || toBob.type !== "room-state") {
      throw new Error("expected room-state");
    }
    expect(toAlice.snapshot.myQueue.map((i) => i.id)).toEqual(["a1"]);
    expect(toBob.snapshot.myQueue).toEqual([]);
  });

  it("keeps a socket in at most one room", () => {
    const { connection } = authed();
    send(connection, { type: "join-room", roomId: "first" });
    send(connection, { type: "join-room", roomId: "second" });

    expect(connection.roomId).toBe("second");
    expect(rooms.has("first")).toBe(false);
  });

  it("discards the room when the last member leaves", () => {
    const { connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });
    expect(rooms.has("jam")).toBe(true);

    send(connection, { type: "leave-room", roomId: "jam" });
    expect(rooms.has("jam")).toBe(false);
  });

  it("discards the room when the last socket closes", () => {
    const { connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });

    session.close(connection);
    expect(rooms.has("jam")).toBe(false);
  });

  it("keeps the identity in the room while a second socket holds it", () => {
    const first = authed();
    const second = authed();
    send(first.connection, { type: "join-room", roomId: "jam" });
    send(second.connection, { type: "join-room", roomId: "jam" });

    session.close(first.connection);
    expect(rooms.has("jam")).toBe(true);
    expect(rooms.get("jam").members.has(alice.publicKey)).toBe(true);

    session.close(second.connection);
    expect(rooms.has("jam")).toBe(false);
  });

  it("rejects an op signed by a key other than the session's", () => {
    const { socket, connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });
    socket.clear();

    send(connection, { type: "clear-queue", roomId: "jam" }, bob);
    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "unknown-identity" });
  });
});
