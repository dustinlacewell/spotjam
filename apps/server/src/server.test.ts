// Integration — two real websocket clients against a real listening server.

import { generateKeypair, seal, type CanonicalValue, type Keypair, type ServerEvent } from "@spotjam/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { MemoryIdentityStore } from "./identity-store.ts";
import { startServer, type RunningServer } from "./server.ts";
import { waitFor } from "./testing.ts";

let running: RunningServer | null = null;

afterEach(async () => {
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

/** A client that queues received events so a test can await the next one. */
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
    return new Client(socket);
  }

  send(payload: CanonicalValue, identity: Keypair): void {
    this.#socket.send(JSON.stringify(seal(payload, identity)));
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

  close(): void {
    this.#socket.close();
  }
}

function expectRoomState(event: ServerEvent) {
  if (event.type !== "room-state") throw new Error(`expected room-state, got ${event.type}`);
  return event.snapshot;
}

describe("server", () => {
  it("answers the health endpoint", async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("drives two clients through register, join, enqueue and snapshot", async () => {
    const server = await start();
    const alice = generateKeypair();
    const bob = generateKeypair();

    const clientA = await Client.connect(server.port);
    const clientB = await Client.connect(server.port);

    clientA.send({ type: "register", username: "alice" }, alice);
    expect(await clientA.next()).toMatchObject({ type: "registered", username: "alice" });

    clientB.send({ type: "register", username: "bob" }, bob);
    expect(await clientB.next()).toMatchObject({ type: "registered", username: "bob" });

    clientA.send({ type: "join-room", roomId: "jam" }, alice);
    expect(expectRoomState(await clientA.next()).participants).toHaveLength(1);

    // Bob joining reaches both sockets, so Alice sees the room grow.
    clientB.send({ type: "join-room", roomId: "jam" }, bob);
    expect(expectRoomState(await clientA.next()).participants).toHaveLength(2);
    expect(expectRoomState(await clientB.next()).participants).toHaveLength(2);

    clientA.send({ type: "set-broadcasting", roomId: "jam", broadcasting: true }, alice);
    await clientA.next();
    await clientB.next();

    clientA.send(
      {
        type: "enqueue",
        roomId: "jam",
        items: [{ id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
      },
      alice,
    );

    const alicesView = expectRoomState(await clientA.next());
    const bobsView = expectRoomState(await clientB.next());

    // Alice is already broadcasting, so a1 leaves her queue and starts playing.
    expect(alicesView.myQueue).toEqual([]);
    expect(alicesView.pointer.itemId).toBe("a1");
    // The pointer is shared state: Bob sees the same track Alice is feeding.
    expect(bobsView.myQueue).toEqual([]);
    expect(bobsView.pointer).toMatchObject({
      itemId: "a1",
      ownerPubkey: alice.publicKey,
      uri: "spotify:track:a1",
    });

    clientA.close();
    clientB.close();
  });

  it("discards a room once every client disconnects", async () => {
    const server = await start();
    const alice = generateKeypair();

    const client = await Client.connect(server.port);
    client.send({ type: "register", username: "alice" }, alice);
    await client.next();
    client.send({ type: "join-room", roomId: "jam" }, alice);
    await client.next();

    expect(server.rooms.has("jam")).toBe(true);

    client.close();
    await waitFor(() => server.rooms.has("jam") === false);
    expect(server.rooms.ids()).toEqual([]);
  });

  it("survives a garbage frame", async () => {
    const server = await start();
    const client = await Client.connect(server.port);

    client.send({ type: "register", username: "alice" }, generateKeypair());
    await client.next();

    // A raw non-envelope frame must draw an error, not kill the process.
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      socket.once("open", () => {
        socket.send("not an envelope");
        socket.once("message", (data) => {
          expect(JSON.parse(data.toString())).toMatchObject({
            type: "error",
            code: "malformed",
          });
          socket.close();
          resolve();
        });
      });
    });

    client.close();
  });
});
