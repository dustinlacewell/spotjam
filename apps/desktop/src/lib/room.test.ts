import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fromHex } from "./testing";
import {
  NULL_POINTER,
  canonicalBytes,
  generateKeypair,
  open,
  positionAt,
  signBytes,
  type Envelope,
  type Keypair,
  type QueueItem,
  type RoomSnapshot,
  type ServerEvent,
} from "@spotjam/protocol";
import { IdentityClient } from "./identity";
import { Connection, type SocketLike } from "./connection";
import { RoomClient } from "./room";

const ROOM = "jam";
const EPOCH = 1_700_000_000_000;

/** Signs with a real keypair, so envelopes round-trip through `open()`. */
function makeIdentity(keypair: Keypair): IdentityClient {
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd !== "identity_sign") throw new Error(`unexpected command ${cmd}`);
    return signBytes(fromHex(args?.messageHex as string), keypair.secretKey) as T;
  };
  return new IdentityClient(invoke);
}

/** A socket the test drives by hand: nothing opens or closes on its own. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  drop(): void {
    this.onclose?.({});
  }

  /** Every envelope this socket has been handed, in order. */
  envelopes(): Envelope[] {
    return this.sent.map((raw) => JSON.parse(raw) as Envelope);
  }

  payloads(): unknown[] {
    return this.envelopes().map((envelope) => envelope.payload);
  }

  types(): string[] {
    return this.payloads().map((payload) => (payload as { type: string }).type);
  }
}

/** Builds a room over fake sockets and fake timers, and hands back the controls. */
function makeRoom(options: { username?: string } = {}) {
  const keypair = generateKeypair();
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const connection = new Connection(
    { publicKey: keypair.publicKey, username: options.username ?? "alice" },
    {
      url: "wss://test.invalid",
      identity: makeIdentity(keypair),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      now: () => EPOCH,
    },
  );
  // This machine's clock, apart from the server's. The two start equal so a
  // test that says nothing about skew sees none; `setLocalNow` introduces it.
  let localNow = EPOCH;
  const room = new RoomClient(connection, ROOM, () => localNow);

  return {
    room,
    connection,
    keypair,
    sockets,
    timers,
    setLocalNow: (value: number) => {
      localNow = value;
    },
    latest: () => sockets[sockets.length - 1],
    /** Runs the pending reconnect timer, as a real clock would. */
    runTimer: () => {
      const timer = timers.shift();
      timer?.fn();
    },
  };
}

/** A queue item. Every one carries a length; nothing here cares which. */
function item(id: string, trackId = id): QueueItem {
  return { id, uri: `spotify:track:${trackId}`, trackId, durationMs: 200_000 };
}

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: ROOM,
    participants: [],
    sessionQueue: [],
    myQueue: [],
    pointer: NULL_POINTER,
    serverTime: EPOCH,
    ...overrides,
  };
}

/** The queue store reads a global `localStorage`; node has none. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

/** Lets the handshake's promise chain settle. */
const settle = () => Promise.resolve().then(() => {}).then(() => {}).then(() => {});

/** Opens the socket and plays the server's side of a successful greeting. */
async function greet(socket: FakeSocket, pubkey: string): Promise<void> {
  socket.open();
  await settle();
  socket.deliver({ type: "registered", pubkey, username: "alice" });
  await settle();
}

describe("RoomClient handshake", () => {
  it("sends a signed hello, then join-room once the server answers", async () => {
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    expect(latest().types()).toEqual(["hello", "join-room"]);

    // The server accepts only envelopes it can verify, so every frame must open.
    for (const envelope of latest().envelopes()) {
      const result = open(envelope, EPOCH);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pubkey).toBe(keypair.publicKey);
    }
    room.destroy();
  });

  it("does not ask for the room until the server has greeted back", async () => {
    const { room, latest } = makeRoom();
    latest().open();
    await settle();

    // Nothing has answered yet, so joining would be premature.
    expect(latest().types()).toEqual(["hello"]);
    room.destroy();
  });

  it("joins the room it was constructed for", async () => {
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    expect(latest().payloads()[1]).toEqual({ type: "join-room", roomId: ROOM });
    room.destroy();
  });

  it("registers the stored username when the server does not know the key", async () => {
    const { room, latest, keypair } = makeRoom({ username: "alice" });
    const socket = latest();
    socket.open();
    await settle();

    // The server answers hello with unknown-identity; the client falls back.
    socket.deliver({
      type: "error",
      code: "unknown-identity",
      message: "This key has not registered a username.",
    });
    await settle();

    expect(socket.payloads()[1]).toEqual({ type: "register", username: "alice" });

    // Registration succeeds, and only then is the room asked for.
    socket.deliver({ type: "registered", pubkey: keypair.publicKey, username: "alice" });
    await settle();

    expect(socket.types()).toEqual(["hello", "register", "join-room"]);
    room.destroy();
  });

  it("registers only once, even if another error follows", async () => {
    const { room, latest } = makeRoom({ username: "alice" });
    const socket = latest();
    socket.open();
    await settle();

    const unknown = {
      type: "error",
      code: "unknown-identity",
      message: "This key has not registered a username.",
    } as const;
    socket.deliver(unknown);
    await settle();
    socket.deliver(unknown);
    await settle();

    expect(socket.types().filter((type) => type === "register")).toHaveLength(1);
    room.destroy();
  });

  it("stops when registration is refused instead of hanging", async () => {
    const { room, latest } = makeRoom({ username: "alice" });
    const socket = latest();
    socket.open();
    await settle();

    socket.deliver({
      type: "error",
      code: "unknown-identity",
      message: "This key has not registered a username.",
    });
    await settle();

    // The name is already someone else's. Sending it again earns the same
    // answer, so the handshake must stop and let the UI surface the error.
    socket.deliver({
      type: "error",
      code: "username-taken",
      message: "Registration refused: username-taken.",
    });
    await settle();

    expect(socket.types()).toEqual(["hello", "register"]);
    expect(room.lastError()?.code).toBe("username-taken");
    room.destroy();
  });

  it("keeps quiet about the first-run miss but reports a real error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { room, latest } = makeRoom({ username: "alice" });
      const socket = latest();
      socket.open();
      await settle();

      // Every first run provokes this; reporting it reads as a broken app.
      socket.deliver({
        type: "error",
        code: "unknown-identity",
        message: "This key has not registered a username.",
      });
      await settle();
      expect(warn).not.toHaveBeenCalled();

      socket.deliver({
        type: "error",
        code: "username-taken",
        message: "Registration refused: username-taken.",
      });
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      room.destroy();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("RoomClient status", () => {
  it("tells status listeners when the first snapshot lands", async () => {
    const { room, latest, keypair } = makeRoom();
    const statuses: ConnectionStatus[] = [];
    room.onStatus((status) => statuses.push(status));
    await greet(latest(), keypair.publicKey);

    // No snapshot yet: the room must not report itself synced before one lands.
    expect(room.getStatus()).toEqual({ socket: "connected", synced: false });

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    await settle();

    // The UI subscribes to status, not to snapshots. Flipping `synced` inside
    // the view without telling it leaves the room reading "joining" forever.
    expect(statuses.at(-1)).toEqual({ socket: "connected", synced: true });
    expect(room.getStatus().synced).toBe(true);
    room.destroy();
  });
});

describe("RoomClient ops", () => {
  async function connected() {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().sent.length = 0;
    return harness;
  }

  it("maps every mutating method onto its op", async () => {
    const { room, latest } = await connected();

    room.appendToMyQueue([item("i1", "x")]);
    room.removeFromMyQueue("i1");
    room.moveManyInMyQueue(["i1"], "i2");
    room.sendToTopOfMyQueue("i2");
    room.shuffleMyQueue();
    room.clearMyQueue();
    room.setBroadcasting(true);
    room.setPaused(true);
    room.seekTo(4200);
    room.skip();
    await settle();

    expect(latest().types()).toEqual([
      "enqueue",
      "remove",
      "move-many",
      "send-to-top",
      "shuffle",
      "clear-queue",
      "set-broadcasting",
      "set-paused",
      "seek",
      "skip",
    ]);
    room.destroy();
  });

  it("carries the op's own fields", async () => {
    const { room, latest } = await connected();
    const queued = item("i1", "x");

    room.appendToMyQueue([queued]);
    room.seekTo(4200);
    await settle();

    expect(latest().payloads()[0]).toEqual({ type: "enqueue", roomId: ROOM, items: [queued] });
    expect(latest().payloads()[1]).toEqual({ type: "seek", roomId: ROOM, positionMs: 4200 });
    room.destroy();
  });

  it("replaces a queue as a clear followed by an enqueue", async () => {
    const { room, latest } = await connected();

    room.replaceMyQueue([item("i1", "x")]);
    await settle();

    expect(latest().types()).toEqual(["clear-queue", "enqueue"]);
    room.destroy();
  });

  it("sends nothing for an empty append", async () => {
    const { room, latest } = await connected();

    room.appendToMyQueue([]);
    await settle();

    expect(latest().sent).toHaveLength(0);
    room.destroy();
  });

  it("reads local time as server time before any snapshot", async () => {
    const { room, setLocalNow } = await connected();

    // Nothing has been folded yet, so there is no offset to apply. Nothing is
    // playing either, so nothing reads a position out of the guess.
    setLocalNow(EPOCH + 1234);
    expect(room.serverNow()).toBe(EPOCH + 1234);
    room.destroy();
  });

  it("folds each snapshot's server time into its clock offset", async () => {
    const { room, latest, setLocalNow } = await connected();

    // The server's clock reads 5s ahead of this machine's.
    setLocalNow(EPOCH);
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({ serverTime: EPOCH + 5_000 }),
    });
    await settle();

    expect(room.serverNow()).toBe(EPOCH + 5_000);
    room.destroy();
  });

  it("keeps the offset as the local clock moves on", async () => {
    const { room, latest, setLocalNow } = await connected();

    setLocalNow(EPOCH);
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({ serverTime: EPOCH + 5_000 }),
    });
    await settle();

    // The offset is a constant shift, not a frozen reading: local time runs on
    // and the server clock runs on with it.
    setLocalNow(EPOCH + 30_000);
    expect(room.serverNow()).toBe(EPOCH + 35_000);
    room.destroy();
  });

  it("lets a position read off the pointer land inside the track", async () => {
    const { room, latest, setLocalNow } = await connected();

    // The server started the track 10s ago in its own clock, which is 60s
    // ahead of ours. Read against Date.now() this would be a minute wrong.
    setLocalNow(EPOCH);
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({
        serverTime: EPOCH + 60_000,
        pointer: {
          ...NULL_POINTER,
          itemId: "i1",
          uri: "spotify:track:x",
          startedAtEpochMs: EPOCH + 50_000,
          durationMs: 200_000,
        },
      }),
    });
    await settle();

    expect(positionAt(room.getPlaybackPointer(), room.serverNow())).toBe(10_000);
    room.destroy();
  });

  it("adopts a later larger sample rather than blending the latency bias in", async () => {
    const { room, latest, setLocalNow } = await connected();

    setLocalNow(EPOCH);
    latest().deliver({ type: "room-state", snapshot: snapshot({ serverTime: EPOCH }) });
    await settle();
    expect(room.serverNow()).toBe(EPOCH);

    // Each sample is biased low by its network hop, so the estimate is the
    // largest sample in the window — not an average that pins the bias in.
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({ serverTime: EPOCH + 10_000 }),
    });
    await settle();

    const drift = room.serverNow() - EPOCH;
    expect(drift).toBe(10_000);
    room.destroy();
  });
});

describe("RoomClient snapshots", () => {
  it("serves the snapshot through the getters and notifies listeners", async () => {
    const { room, latest } = makeRoom();
    const changes = vi.fn();
    room.onChange(changes);
    latest().open();
    await settle();

    const entry = { item: item("a1"), ownerPubkey: room.myPubkey, ownerName: "alice" };
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({
        participants: [
          {
            pubkey: room.myPubkey,
            username: "alice",
            broadcasting: true,
            playlistsRevision: 0,
          },
        ],
        sessionQueue: [entry],
        myQueue: [entry.item],
        pointer: { ...NULL_POINTER, itemId: "a1", uri: "ua1", ownerPubkey: room.myPubkey },
      }),
    });

    expect(changes).toHaveBeenCalled();
    expect(room.sessionQueue()).toEqual([entry]);
    expect(room.myQueue()).toEqual([entry.item]);
    expect(room.getPlaybackPointer().itemId).toBe("a1");
    expect(room.isBroadcasting()).toBe(true);
    expect(room.usernameOf(room.myPubkey)).toBe("alice");
    room.destroy();
  });

  it("reports an empty room until the first snapshot lands", () => {
    const { room } = makeRoom();

    expect(room.snapshot()).toBeNull();
    expect(room.sessionQueue()).toEqual([]);
    expect(room.getPlaybackPointer()).toEqual(NULL_POINTER);
    room.destroy();
  });

  it("ignores frames that are not protocol events", async () => {
    const { room, latest } = makeRoom();
    latest().open();
    await settle();
    const changes = vi.fn();
    room.onChange(changes);

    latest().onmessage?.({ data: "not json" });
    latest().onmessage?.({ data: JSON.stringify({ type: "nonsense" }) });
    latest().onmessage?.({ data: 42 });

    expect(changes).not.toHaveBeenCalled();
    room.destroy();
  });
});

describe("RoomClient queue restore", () => {
  const KEY = `spotjam.queue.${ROOM}`;
  const STORED = [item("i1", "x"), item("i2", "y")];

  /** Every enqueue payload the live socket has been handed. */
  function enqueues(socket: FakeSocket): unknown[] {
    return socket.payloads().filter((p) => (p as { type: string }).type === "enqueue");
  }

  it("restores the stored queue when a restarted server has none", async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED));
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    await settle();

    expect(enqueues(latest())).toEqual([{ type: "enqueue", roomId: ROOM, items: STORED }]);
    room.destroy();
  });

  it("restores once, not on every later snapshot", async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED));
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    latest().deliver({ type: "room-state", snapshot: snapshot() });
    await settle();

    expect(enqueues(latest())).toHaveLength(1);
    room.destroy();
  });

  it("restores nothing when the server still holds the queue", async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED));
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    latest().deliver({ type: "room-state", snapshot: snapshot({ myQueue: STORED }) });
    await settle();

    expect(enqueues(latest())).toEqual([]);
    room.destroy();
  });

  it("restores again after a reconnect", async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED));
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({ type: "room-state", snapshot: snapshot({ myQueue: STORED }) });
    await settle();

    // The server restarts: the socket drops, the client rejoins, and the
    // room comes back empty.
    harness.latest().drop();
    harness.runTimer();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({ type: "room-state", snapshot: snapshot() });
    await settle();

    expect(enqueues(harness.latest())).toEqual([
      { type: "enqueue", roomId: ROOM, items: STORED },
    ]);
    harness.room.destroy();
  });

  it("stores every snapshot's queue", async () => {
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    latest().deliver({ type: "room-state", snapshot: snapshot({ myQueue: STORED }) });
    await settle();

    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(STORED);
    room.destroy();
  });
});

describe("RoomClient broadcasting restore", () => {
  /** Every set-broadcasting payload the live socket has been handed. */
  function claims(socket: FakeSocket): unknown[] {
    return socket.payloads().filter((p) => (p as { type: string }).type === "set-broadcasting");
  }

  /** A snapshot where we are a member, broadcasting or not. */
  function member(pubkey: string, broadcasting: boolean): RoomSnapshot {
    return snapshot({
      participants: [{ pubkey, username: "alice", broadcasting, playlistsRevision: 0 }],
    });
  }

  /** Drop the socket, run the retry, and greet the replacement. */
  async function reconnect(harness: ReturnType<typeof makeRoom>): Promise<void> {
    harness.latest().drop();
    harness.runTimer();
    await greet(harness.latest(), harness.keypair.publicKey);
  }

  it("re-claims the role when a rejoin comes back not broadcasting", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, true),
    });
    await settle();

    await reconnect(harness);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    expect(claims(harness.latest())).toEqual([
      { type: "set-broadcasting", roomId: ROOM, broadcasting: true },
    ]);
    harness.room.destroy();
  });

  it("claims nothing for a client that was never broadcasting", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    await reconnect(harness);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    expect(claims(harness.latest())).toEqual([]);
    harness.room.destroy();
  });

  it("claims nothing when the user turned it off before the drop", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, true),
    });
    // Stopping is the user's own decision; the reconnect must respect it.
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    await reconnect(harness);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    expect(claims(harness.latest())).toEqual([]);
    harness.room.destroy();
  });

  it("claims nothing when the server still has us broadcasting", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, true),
    });
    await settle();

    await reconnect(harness);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, true),
    });
    await settle();

    expect(claims(harness.latest())).toEqual([]);
    harness.room.destroy();
  });

  it("claims once, not on every later snapshot", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, true),
    });
    await settle();

    await reconnect(harness);
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    harness.latest().deliver({
      type: "room-state",
      snapshot: member(harness.room.myPubkey, false),
    });
    await settle();

    expect(claims(harness.latest())).toHaveLength(1);
    harness.room.destroy();
  });
});

describe("RoomClient errors", () => {
  it("surfaces a typed error with copy for the user", async () => {
    const { room, latest } = makeRoom();
    latest().open();
    await settle();

    latest().deliver({
      type: "error",
      code: "stale-envelope",
      message: "Envelope rejected: stale-timestamp.",
    });

    expect(room.lastError()?.code).toBe("stale-envelope");
    // A skewed clock needs its own sentence: retrying will never fix it.
    expect(room.lastError()?.humanMessage).toMatch(/clock/i);
    room.destroy();
  });

  it("clears the error once the room reports state again", async () => {
    const { room, latest } = makeRoom();
    latest().open();
    await settle();

    latest().deliver({ type: "error", code: "internal", message: "boom" });
    expect(room.lastError()).not.toBeNull();

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    expect(room.lastError()).toBeNull();
    room.destroy();
  });
});

describe("RoomClient reconnect", () => {
  it("reports disconnected and schedules a retry when the socket drops", async () => {
    const { room, latest, timers } = makeRoom();
    latest().open();
    await settle();

    latest().drop();

    expect(room.getStatus()).toEqual({ socket: "disconnected", synced: false });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(500);
    room.destroy();
  });

  it("re-sends hello and join on the new socket", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);

    harness.latest().drop();
    harness.runTimer();
    await greet(harness.latest(), harness.keypair.publicKey);

    expect(harness.sockets).toHaveLength(2);
    expect(harness.latest().types()).toEqual(["hello", "join-room"]);
    harness.room.destroy();
  });

  it("backs off further on each successive failure", async () => {
    const harness = makeRoom();
    harness.latest().open();
    await settle();

    harness.latest().drop();
    expect(harness.timers[0].ms).toBe(500);

    harness.runTimer();
    harness.latest().drop();
    expect(harness.timers[0].ms).toBe(1000);

    harness.runTimer();
    harness.latest().drop();
    expect(harness.timers[0].ms).toBe(2000);
    harness.room.destroy();
  });

  it("resets the backoff after a connection succeeds", async () => {
    const harness = makeRoom();
    await greet(harness.latest(), harness.keypair.publicKey);

    harness.latest().drop();
    harness.runTimer();
    harness.latest().open(); // a good connection resets the schedule
    await settle();
    harness.latest().drop();

    expect(harness.timers[0].ms).toBe(500);
    harness.room.destroy();
  });

  it("stops reconnecting once the connection is destroyed", async () => {
    const harness = makeRoom();
    harness.latest().open();
    await settle();

    harness.room.destroy();
    harness.connection.destroy();
    harness.latest().drop();

    expect(harness.timers).toHaveLength(0);
    expect(harness.sockets).toHaveLength(1);
  });

  it("closes the live socket when the connection is destroyed", async () => {
    const harness = makeRoom();
    harness.latest().open();
    await settle();

    harness.room.destroy();
    harness.connection.destroy();

    expect(harness.latest().closed).toBe(true);
  });

  it("ignores a frame from a socket that has already been replaced", async () => {
    const harness = makeRoom();
    const stale = harness.latest();
    stale.open();
    await settle();

    stale.drop();
    harness.runTimer();
    await settle();

    // The dead socket speaks after its replacement exists; it must not land.
    stale.deliver({ type: "room-state", snapshot: snapshot({ roomId: "stale" }) });

    expect(harness.room.snapshot()).toBeNull();
    harness.room.destroy();
  });
});
