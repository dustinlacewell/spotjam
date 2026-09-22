import { beforeEach, describe, expect, it } from "vitest";

import {
  startHeartbeat,
  type Pingable,
  type PingableServer,
} from "./heartbeat.ts";
import { FakeTimers } from "./testing.ts";

/** A socket that records its pings and answers only when the test says so. */
class FakeSocket implements Pingable {
  pings = 0;
  terminated = false;
  #pong: (() => void) | null = null;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
  }

  on(_event: "pong", listener: () => void): this {
    this.#pong = listener;
    return this;
  }

  /** Answer the last ping, as a live client would. */
  pong(): void {
    this.#pong?.();
  }
}

/** The slice of a WebSocketServer the heartbeat watches. */
class FakeServer implements PingableServer {
  readonly clients = new Set<FakeSocket>();
  #onConnection: ((socket: Pingable) => void) | null = null;

  on(_event: "connection", listener: (socket: Pingable) => void): this {
    this.#onConnection = listener;
    return this;
  }

  connect(): FakeSocket {
    const socket = new FakeSocket();
    this.clients.add(socket);
    this.#onConnection?.(socket);
    return socket;
  }
}

let timers: FakeTimers;
let server: FakeServer;

beforeEach(() => {
  timers = new FakeTimers();
  server = new FakeServer();
});

describe("startHeartbeat", () => {
  it("runs on the heartbeat period", () => {
    startHeartbeat({ server, timers });

    expect(timers.repeatingCount).toBe(1);
    // Pinned to a literal: the constant asserting itself passes at any value.
    expect(timers.repeatingPeriod).toBe(30_000);
  });

  it("pings every client on a tick", () => {
    startHeartbeat({ server, timers });
    const alice = server.connect();
    const bob = server.connect();

    timers.tick();

    expect(alice.pings).toBe(1);
    expect(bob.pings).toBe(1);
  });

  it("terminates a client that never answered the previous ping", () => {
    startHeartbeat({ server, timers });
    const silent = server.connect();

    // The first tick only pings: a client gets a whole period to answer.
    timers.tick();
    expect(silent.terminated).toBe(false);

    timers.tick();
    expect(silent.terminated).toBe(true);
  });

  it("keeps a client that pongs", () => {
    startHeartbeat({ server, timers });
    const live = server.connect();

    timers.tick();
    live.pong();
    timers.tick();

    expect(live.terminated).toBe(false);
    expect(live.pings).toBe(2);
  });

  it("terminates only the client that went quiet", () => {
    startHeartbeat({ server, timers });
    const live = server.connect();
    const silent = server.connect();

    timers.tick();
    live.pong();
    timers.tick();

    expect(silent.terminated).toBe(true);
    expect(live.terminated).toBe(false);
  });

  it("does not terminate a client that connected after the last tick", () => {
    startHeartbeat({ server, timers });
    const latecomer = server.connect();

    // A fresh socket counts as answered, so its first tick is a ping, not a
    // hang-up on a client that has never been asked anything.
    timers.tick();

    expect(latecomer.terminated).toBe(false);
    expect(latecomer.pings).toBe(1);
  });

  it("watches clients that were already connected when it started", () => {
    const early = server.connect();
    startHeartbeat({ server, timers });

    timers.tick();
    early.pong();
    timers.tick();

    expect(early.terminated).toBe(false);
    expect(early.pings).toBe(2);
  });

  it("stops the interval when the server closes", () => {
    const heartbeat = startHeartbeat({ server, timers });
    const silent = server.connect();

    heartbeat.stop();
    timers.tick();

    expect(timers.repeatingCount).toBe(0);
    expect(silent.pings).toBe(0);
  });
});
