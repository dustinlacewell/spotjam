import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  signBytes,
  NULL_POINTER,
  type Keypair,
  type RoomSnapshot,
  type RoomSummary,
  type ServerEvent,
} from "@spotjam/protocol";
import { IdentityClient } from "./identity";
import {
  Connection,
  isRoomDetailEvent,
  isRoomListEvent,
  type SocketLike,
} from "./connection";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeIdentity(keypair: Keypair): IdentityClient {
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd !== "identity_sign") throw new Error(`unexpected command ${cmd}`);
    return signBytes(fromHex(args?.messageHex as string), keypair.secretKey) as T;
  };
  return new IdentityClient(invoke);
}

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

  payloads(): unknown[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { payload: unknown }).payload);
  }

  types(): string[] {
    return this.payloads().map((payload) => (payload as { type: string }).type);
  }
}

function makeConnection() {
  const keypair = generateKeypair();
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const connection = new Connection(
    { publicKey: keypair.publicKey, username: "alice" },
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
      now: () => 1_700_000_000_000,
    },
  );

  return {
    connection,
    keypair,
    sockets,
    latest: () => sockets[sockets.length - 1],
    runTimer: () => timers.shift()?.fn(),
  };
}

const settle = () => Promise.resolve().then(() => {}).then(() => {}).then(() => {});

async function greet(socket: FakeSocket, pubkey: string): Promise<void> {
  socket.open();
  await settle();
  socket.deliver({ type: "registered", pubkey, username: "alice" });
  await settle();
}

const ROOM_SUMMARY: RoomSummary = {
  roomId: "jam",
  listeners: 2,
  trackUri: "spotify:track:abc",
  createdAtEpochMs: 1_700_000_000_000,
};

function snapshotOf(roomId: string): RoomSnapshot {
  return {
    roomId,
    participants: [],
    sessionQueue: [],
    myQueue: [],
    pointer: NULL_POINTER,
    progress: null,
    serverTime: 1_700_000_000_000,
  };
}

describe("Connection queries", () => {
  it("does not send a query before the handshake is done", async () => {
    const { connection, latest } = makeConnection();
    latest().open();
    await settle();

    connection.send({ type: "watch-rooms" });
    await settle();

    // The greeting is the only frame; a query sent before registration would
    // reach the server with no authenticated identity behind it.
    expect(latest().types()).toEqual(["hello"]);
    connection.destroy();
  });

  it("sends a watch-rooms query once ready", async () => {
    const { connection, latest, keypair } = makeConnection();
    await greet(latest(), keypair.publicKey);

    connection.send({ type: "watch-rooms" });
    await settle();

    expect(latest().types()).toEqual(["hello", "watch-rooms"]);
    connection.destroy();
  });

  it("sends a watch-room query naming the room", async () => {
    const { connection, latest, keypair } = makeConnection();
    await greet(latest(), keypair.publicKey);

    connection.send({ type: "watch-room", roomId: "jam" });
    await settle();

    expect(latest().payloads().at(-1)).toEqual({ type: "watch-room", roomId: "jam" });
    connection.destroy();
  });

  it("delivers a room-list event to onEvent listeners", async () => {
    const { connection, latest, keypair } = makeConnection();
    await greet(latest(), keypair.publicKey);

    const events: ServerEvent[] = [];
    connection.onEvent((event) => events.push(event));

    latest().deliver({ type: "room-list", rooms: [ROOM_SUMMARY] });

    const roomList = events.find(isRoomListEvent);
    expect(roomList?.rooms).toEqual([ROOM_SUMMARY]);
    connection.destroy();
  });

  it("delivers a room-detail event to onEvent listeners", async () => {
    const { connection, latest, keypair } = makeConnection();
    await greet(latest(), keypair.publicKey);

    const events: ServerEvent[] = [];
    connection.onEvent((event) => events.push(event));

    latest().deliver({ type: "room-detail", snapshot: snapshotOf("jam") });

    const detail = events.find(isRoomDetailEvent);
    expect(detail?.snapshot.roomId).toBe("jam");
    connection.destroy();
  });

  it("fires onReady again after a reconnect, so a caller can re-issue a query", async () => {
    const harness = makeConnection();
    await greet(harness.latest(), harness.keypair.publicKey);

    let readyCount = 0;
    harness.connection.onReady(() => {
      readyCount += 1;
    });
    expect(readyCount).toBe(0);

    harness.latest().drop();
    harness.runTimer();
    await greet(harness.latest(), harness.keypair.publicKey);

    expect(readyCount).toBe(1);
    harness.connection.destroy();
  });
});
