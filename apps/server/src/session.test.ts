import {
  generateKeypair,
  seal,
  type ServerEvent,
  type SharedPlaylist,
} from "@spotjam/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { newConnection, type Connection } from "./connections.ts";
import { MemoryIdentityStore } from "./identity-store.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { RoomRegistry } from "./rooms.ts";
import { Session } from "./session.ts";
import { FakeClock, FakeTimers, RecordingSocket, seededRng } from "./testing.ts";

const alice = generateKeypair();
const bob = generateKeypair();

let clock: FakeClock;
let timers: FakeTimers;
let rooms: RoomRegistry;
let identities: MemoryIdentityStore;
let session: Session;

beforeEach(() => {
  clock = new FakeClock();
  timers = new FakeTimers();
  rooms = new RoomRegistry();
  identities = new MemoryIdentityStore();
  session = new Session({
    rooms,
    identities,
    replay: new ReplayGuard(),
    clock,
    rng: seededRng(1),
    // Track ends are scheduled, so a real timer would outlive the test.
    timers,
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
      items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
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

  it("starts playing once a member queues a track and broadcasts", () => {
    const { socket, connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });
    send(connection, {
      type: "enqueue",
      roomId: "jam",
      items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
    });
    send(connection, { type: "set-broadcasting", roomId: "jam", broadcasting: true });

    const event = lastEvent(socket);
    expect(event.type).toBe("room-state");
    if (event.type !== "room-state") return;
    expect(event.snapshot.pointer).toMatchObject({
      itemId: "a1",
      ownerPubkey: alice.publicKey,
      uri: "spotify:track:a1",
    });
  });

  it("ends a track on the clock and tells every member", () => {
    const a = authed(alice, "alice");
    const b = authed(bob, "bob");
    send(a.connection, { type: "join-room", roomId: "jam" });
    send(b.connection, { type: "join-room", roomId: "jam" }, bob);
    send(a.connection, {
      type: "enqueue",
      roomId: "jam",
      items: [
        { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 60_000 },
        { id: "a2", uri: "spotify:track:a2", trackId: "a2", durationMs: 60_000 },
      ],
    });
    send(a.connection, { type: "set-broadcasting", roomId: "jam", broadcasting: true });
    a.socket.clear();
    b.socket.clear();

    // Nobody reports the end of a1; the server's own timer does.
    expect(timers.pendingDelay).toBe(60_000);
    clock.advance(60_000);
    timers.fire();

    for (const socket of [a.socket, b.socket]) {
      const event = lastEvent(socket);
      expect(event.type).toBe("room-state");
      if (event.type !== "room-state") return;
      expect(event.snapshot.pointer.itemId).toBe("a2");
    }
    // And the next track is already armed.
    expect(timers.pendingDelay).toBe(60_000);
  });

  it("stops arming once a room is deserted", () => {
    const { connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });
    send(connection, {
      type: "enqueue",
      roomId: "jam",
      items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 60_000 }],
    });
    send(connection, { type: "set-broadcasting", roomId: "jam", broadcasting: true });
    expect(timers.pendingCount).toBe(1);

    session.close(connection);

    expect(rooms.has("jam")).toBe(false);
    expect(timers.pendingCount).toBe(0);
  });

  it("rejects an op signed by a key other than the session's", () => {
    const { socket, connection } = authed();
    send(connection, { type: "join-room", roomId: "jam" });
    socket.clear();

    send(connection, { type: "clear-queue", roomId: "jam" }, bob);
    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "unknown-identity" });
  });
});

describe("public playlists", () => {
  const mix: SharedPlaylist = {
    id: "p1",
    name: "Morning",
    tracks: [{ uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
  };

  function authed(identity = alice, username = "alice") {
    const { socket, connection } = connect();
    send(connection, { type: "register", username }, identity);
    socket.clear();
    return { socket, connection };
  }

  /** Alice sharing one playlist, with Bob in the room beside her. */
  function sharedRoom() {
    const a = authed(alice, "alice");
    const b = authed(bob, "bob");
    send(a.connection, { type: "join-room", roomId: "jam" });
    send(b.connection, { type: "join-room", roomId: "jam" }, bob);
    send(a.connection, { type: "set-public-playlists", roomId: "jam", playlists: [mix] });
    a.socket.clear();
    b.socket.clear();
    return { a, b };
  }

  it("answers a viewer with the owner's playlists", () => {
    const { b } = sharedRoom();
    send(b.connection, {
      type: "view-playlists",
      roomId: "jam",
      ownerPubkey: alice.publicKey,
    }, bob);

    expect(b.socket.events()).toEqual([
      {
        type: "playlists",
        roomId: "jam",
        ownerPubkey: alice.publicKey,
        playlists: [mix],
      },
    ]);
  });

  it("tells nobody but the asker", () => {
    const { a, b } = sharedRoom();
    send(b.connection, {
      type: "view-playlists",
      roomId: "jam",
      ownerPubkey: alice.publicKey,
    }, bob);

    // A read moves nothing, so the owner hears neither the answer nor a snapshot.
    expect(a.socket.sent).toHaveLength(0);
  });

  it("publishes no snapshot for a read", () => {
    const { b } = sharedRoom();
    send(b.connection, {
      type: "view-playlists",
      roomId: "jam",
      ownerPubkey: alice.publicKey,
    }, bob);

    expect(b.socket.events<ServerEvent>().map((event) => event.type)).toEqual(["playlists"]);
  });

  it("answers an owner nobody knows with an empty list", () => {
    const { b } = sharedRoom();
    send(b.connection, {
      type: "view-playlists",
      roomId: "jam",
      ownerPubkey: "c".repeat(64),
    }, bob);

    expect(lastEvent(b.socket)).toMatchObject({ type: "playlists", playlists: [] });
  });

  it("rejects a view with no owner key", () => {
    const { b } = sharedRoom();
    send(b.connection, { type: "view-playlists", roomId: "jam", ownerPubkey: "" }, bob);

    expect(lastEvent(b.socket)).toMatchObject({ type: "error", code: "malformed" });
  });

  it("rejects malformed playlists", () => {
    const { a } = sharedRoom();
    send(a.connection, { type: "set-public-playlists", roomId: "jam", playlists: "nope" });

    expect(lastEvent(a.socket)).toMatchObject({ type: "error", code: "malformed" });
  });

  it("replaces the whole set rather than appending", () => {
    const { a, b } = sharedRoom();
    const evening: SharedPlaylist = { id: "p2", name: "Evening", tracks: [] };
    send(a.connection, { type: "set-public-playlists", roomId: "jam", playlists: [evening] });
    send(b.connection, {
      type: "view-playlists",
      roomId: "jam",
      ownerPubkey: alice.publicKey,
    }, bob);

    expect(lastEvent(b.socket)).toMatchObject({ playlists: [evening] });
  });
});

describe("queries", () => {
  function authed(identity = alice, username = "alice") {
    const { socket, connection } = connect();
    send(connection, { type: "register", username }, identity);
    socket.clear();
    return { socket, connection };
  }

  /** Put a broadcasting alice with one playing track into "jam". */
  function playingRoom() {
    const a = authed(alice, "alice");
    send(a.connection, { type: "join-room", roomId: "jam" });
    send(a.connection, {
      type: "enqueue",
      roomId: "jam",
      items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
    });
    // Broadcasting with a track queued starts playback; no kickoff skip needed.
    send(a.connection, { type: "set-broadcasting", roomId: "jam", broadcasting: true });
    return a;
  }

  it("refuses a query before authentication", () => {
    const { socket, connection } = connect();
    send(connection, { type: "watch-rooms" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "unknown-identity" });
  });

  it("rejects a room-scoped query with no room id", () => {
    const { socket, connection } = authed();
    send(connection, { type: "watch-room", roomId: "" });

    expect(lastEvent(socket)).toMatchObject({ type: "error", code: "malformed" });
  });

  describe("watch-rooms", () => {
    it("answers at once with the current list", () => {
      const { socket, connection } = authed();
      send(connection, { type: "watch-rooms" });

      expect(lastEvent(socket)).toEqual({ type: "room-list", rooms: [] });
    });

    it("reports a live room's listener count and current track", () => {
      playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);

      expect(lastEvent(watcher.socket)).toEqual({
        type: "room-list",
        rooms: [
          {
            roomId: "jam",
            listeners: 1,
            trackUri: "spotify:track:a1",
            createdAtEpochMs: clock.now(),
          },
        ],
      });
    });

    it("pushes a new list when someone joins another room", () => {
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);
      watcher.socket.clear();

      const joiner = authed(alice, "alice");
      send(joiner.connection, { type: "join-room", roomId: "jam" });

      expect(lastEvent(watcher.socket)).toEqual({
        type: "room-list",
        rooms: [
          { roomId: "jam", listeners: 1, trackUri: null, createdAtEpochMs: clock.now() },
        ],
      });
    });

    it("pushes nothing when a room moved but its row did not", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);
      watcher.socket.clear();

      // A seek moves the pointer without changing the track a browser lists.
      clock.advance(1_000);
      send(player.connection, { type: "seek", roomId: "jam", positionMs: 1_000 });

      expect(watcher.socket.sent).toHaveLength(0);
    });

    it("stops pushing after unwatch-rooms", () => {
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);
      send(watcher.connection, { type: "unwatch-rooms" }, bob);
      watcher.socket.clear();

      const joiner = authed(alice, "alice");
      send(joiner.connection, { type: "join-room", roomId: "jam" });

      expect(watcher.socket.sent).toHaveLength(0);
    });

    it("pushes a list without a room that just went deserted", () => {
      const joiner = authed(alice, "alice");
      send(joiner.connection, { type: "join-room", roomId: "jam" });

      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);
      watcher.socket.clear();

      send(joiner.connection, { type: "leave-room", roomId: "jam" });

      expect(lastEvent(watcher.socket)).toEqual({ type: "room-list", rooms: [] });
    });

    it("stops pushing to a closed connection", () => {
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-rooms" }, bob);
      session.close(watcher.connection);
      watcher.socket.clear();

      const joiner = authed(alice, "alice");
      send(joiner.connection, { type: "join-room", roomId: "jam" });

      expect(watcher.socket.sent).toHaveLength(0);
    });
  });

  describe("watch-room", () => {
    it("answers at once with a snapshot and an empty myQueue", () => {
      playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);

      const event = lastEvent(watcher.socket);
      expect(event.type).toBe("room-detail");
      if (event.type !== "room-detail") return;
      expect(event.snapshot.roomId).toBe("jam");
      expect(event.snapshot.participants).toHaveLength(1);
      expect(event.snapshot.myQueue).toEqual([]);
      expect(event.snapshot.pointer.uri).toBe("spotify:track:a1");
    });

    it("does not put the watcher in the room", () => {
      playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);

      expect(watcher.connection.roomId).toBeNull();
      expect(rooms.get("jam").members.size).toBe(1);
    });

    it("pushes a snapshot when the watched room changes", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      watcher.socket.clear();

      send(player.connection, {
        type: "enqueue",
        roomId: "jam",
        items: [{ id: "a2", uri: "spotify:track:a2", trackId: "a2", durationMs: 200_000 }],
      });

      const event = lastEvent(watcher.socket);
      expect(event.type).toBe("room-detail");
      if (event.type !== "room-detail") return;
      expect(event.snapshot.sessionQueue.map((entry) => entry.item.id)).toEqual(["a2"]);
    });

    it("pushes a transport-only change too", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      watcher.socket.clear();

      clock.advance(1_000);
      send(player.connection, { type: "set-paused", roomId: "jam", paused: true });

      const event = lastEvent(watcher.socket);
      expect(event.type).toBe("room-detail");
      if (event.type !== "room-detail") return;
      expect(event.snapshot.pointer).toMatchObject({
        isPaused: true,
        pausedAtOffsetMs: 1_000,
      });
    });

    it("watches one room at a time", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      send(watcher.connection, { type: "watch-room", roomId: "other" }, bob);
      watcher.socket.clear();

      send(player.connection, { type: "clear-queue", roomId: "jam" });

      expect(watcher.socket.sent).toHaveLength(0);
    });

    it("stops pushing after unwatch-room", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      send(watcher.connection, { type: "unwatch-room", roomId: "jam" }, bob);
      watcher.socket.clear();

      send(player.connection, { type: "clear-queue", roomId: "jam" });

      expect(watcher.socket.sent).toHaveLength(0);
    });

    it("ignores unwatch-room for a room it is not watching", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      send(watcher.connection, { type: "unwatch-room", roomId: "elsewhere" }, bob);
      watcher.socket.clear();

      send(player.connection, { type: "clear-queue", roomId: "jam" });

      expect(lastEvent(watcher.socket)).toMatchObject({ type: "room-detail" });
    });

    it("stops pushing to a closed connection", () => {
      const player = playingRoom();
      const watcher = authed(bob, "bob");
      send(watcher.connection, { type: "watch-room", roomId: "jam" }, bob);
      session.close(watcher.connection);
      watcher.socket.clear();

      send(player.connection, { type: "clear-queue", roomId: "jam" });

      expect(watcher.socket.sent).toHaveLength(0);
    });
  });
});
