import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NULL_POINTER,
  canonicalBytes,
  generateKeypair,
  open,
  signBytes,
  type Envelope,
  type Keypair,
  type RoomSnapshot,
  type ServerEvent,
} from "@spotjam/protocol";
import { IdentityClient } from "./identity";
import { Connection, type SocketLike } from "./connection";
import { RoomClient } from "./room";

const ROOM = "jam";
const EPOCH = 1_700_000_000_000;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

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
  const room = new RoomClient(connection, ROOM);

  return {
    room,
    connection,
    keypair,
    sockets,
    timers,
    latest: () => sockets[sockets.length - 1],
    /** Runs the pending reconnect timer, as a real clock would. */
    runTimer: () => {
      const timer = timers.shift();
      timer?.fn();
    },
  };
}

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: ROOM,
    participants: [],
    sessionQueue: [],
    myQueue: [],
    pointer: NULL_POINTER,
    progress: null,
    serverTime: EPOCH,
    ...overrides,
  };
}

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

  it("signs the protocol's signing body, so the server can verify", async () => {
    const { room, latest, keypair } = makeRoom();
    await greet(latest(), keypair.publicKey);

    const envelope = latest().envelopes()[0];
    const expected = signBytes(
      canonicalBytes({
        nonce: envelope.nonce,
        payload: envelope.payload,
        pubkey: envelope.pubkey,
        timestamp: envelope.timestamp,
      }),
      keypair.secretKey,
    );
    expect(envelope.signature).toBe(expected);
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

    room.appendToMyQueue([{ id: "i1", uri: "spotify:track:x", trackId: "x" }]);
    room.removeFromMyQueue("i1");
    room.moveInMyQueue(2, 0);
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
      "move",
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
    const item = { id: "i1", uri: "spotify:track:x", trackId: "x" };

    room.appendToMyQueue([item]);
    room.seekTo(4200);
    await settle();

    expect(latest().payloads()[0]).toEqual({ type: "enqueue", roomId: ROOM, items: [item] });
    expect(latest().payloads()[1]).toEqual({ type: "seek", roomId: ROOM, positionMs: 4200 });
    room.destroy();
  });

  it("replaces a queue as a clear followed by an enqueue", async () => {
    const { room, latest } = await connected();

    room.replaceMyQueue([{ id: "i1", uri: "spotify:track:x", trackId: "x" }]);
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

  it("reports progress to the server and keeps the sample for the local bar", async () => {
    const { room, latest } = await connected();

    // The sample only means anything while the room is playing that track.
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({
        pointer: { ...NULL_POINTER, itemId: "i1", uri: "spotify:track:x" },
      }),
    });
    await settle();

    room.setMyProgress({
      itemId: "i1",
      positionMs: 5000,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
    await settle();

    expect(latest().payloads()[0]).toEqual({
      type: "report-progress",
      roomId: ROOM,
      itemId: "i1",
      positionMs: 5000,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
    expect(room.myProgress()?.positionMs).toBe(5000);
    room.destroy();
  });

  it("clears the local sample without sending anything", async () => {
    const { room, latest } = await connected();

    room.setMyProgress(null);
    await settle();

    expect(room.myProgress()).toBeNull();
    expect(latest().sent).toHaveLength(0);
    room.destroy();
  });

  it("prefers the broadcaster's sample over its own", async () => {
    const { room, latest } = await connected();
    const pointer = { ...NULL_POINTER, itemId: "i1", uri: "spotify:track:x" };

    // A listener's own player is silent, so its sample is meaningless here.
    room.setMyProgress({
      itemId: "i1",
      positionMs: 1000,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({
        pointer,
        progress: {
          itemId: "i1",
          positionMs: 90_000,
          durationMs: 200_000,
          sampledAtEpochMs: EPOCH,
        },
      }),
    });
    await settle();

    expect(room.myProgress()?.positionMs).toBe(90_000);
    room.destroy();
  });

  it("falls back to its own sample until the server echoes one", async () => {
    const { room, latest } = await connected();
    const pointer = { ...NULL_POINTER, itemId: "i1", uri: "spotify:track:x" };

    latest().deliver({ type: "room-state", snapshot: snapshot({ pointer }) });
    room.setMyProgress({
      itemId: "i1",
      positionMs: 1000,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
    await settle();

    expect(room.myProgress()?.positionMs).toBe(1000);
    room.destroy();
  });

  it("ignores a local sample left over from the previous track", async () => {
    const { room, latest } = await connected();

    room.setMyProgress({
      itemId: "i1",
      positionMs: 1000,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
    latest().deliver({
      type: "room-state",
      snapshot: snapshot({
        pointer: { ...NULL_POINTER, itemId: "i2", uri: "spotify:track:y" },
      }),
    });
    await settle();

    expect(room.myProgress()).toBeNull();
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

    const entry = {
      item: { id: "a1", uri: "ua1", trackId: "a1" },
      ownerPubkey: room.myPubkey,
      ownerName: "alice",
    };
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

  it("marks the room synced only once a snapshot has arrived", async () => {
    const { room, latest } = makeRoom();
    latest().open();
    await settle();

    expect(room.getStatus()).toEqual({ socket: "connected", synced: false });

    latest().deliver({ type: "room-state", snapshot: snapshot() });
    expect(room.getStatus()).toEqual({ socket: "connected", synced: true });
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
