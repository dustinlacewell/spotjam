// Heartbeat — the ping that keeps an idle socket from being closed under us.
//
// A room can sit silent for a whole track. Nothing is sent, the tunnel in front
// of this server reads the socket as idle, and closes it. The client then
// reconnects and rejoins as a fresh member, which costs it the broadcaster role.
//
// The cure is the standard `ws` pattern: ping every client on a period, and
// treat a client that did not answer the previous ping as gone. The pong
// handler is the only thing that marks a client live again, so a socket that
// the network has quietly dropped is terminated rather than leaked.
//
// The timer arrives injected, like the room clock's, so a test drives real
// behaviour with no waiting.

import type { TimerHandle, Timers } from "./room-clock.ts";

/** How often every client is pinged, and so how long a silent one survives. */
export const HEARTBEAT_PERIOD_MS = 30_000;

/** The slice of a `ws` socket a heartbeat touches. */
export interface Pingable {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

/** The slice of a `WebSocketServer` a heartbeat touches. */
export interface PingableServer {
  readonly clients: Iterable<Pingable>;
  on(event: "connection", listener: (socket: Pingable) => void): unknown;
}

export interface HeartbeatDeps {
  server: PingableServer;
  timers: Timers;
  /** The ping period. Injected only so a test can name its own. */
  periodMs?: number;
}

/** A running heartbeat. Stop it when the server closes. */
export interface Heartbeat {
  stop(): void;
}

/**
 * Ping every client on a period, and hang up on the ones that stopped
 * answering.
 *
 * A client is marked unanswered the moment it is pinged and answered again by
 * its pong. A tick that finds a client still unanswered from the previous tick
 * terminates it: two ticks is one period of grace, which is what the `ws`
 * documentation's own example gives.
 */
export function startHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { server, timers } = deps;
  const period = deps.periodMs ?? HEARTBEAT_PERIOD_MS;
  const answered = new WeakSet<Pingable>();

  const watch = (socket: Pingable): void => {
    answered.add(socket);
    socket.on("pong", () => answered.add(socket));
  };

  // Sockets that connected before this started still need their pong handler.
  for (const socket of server.clients) watch(socket);
  server.on("connection", watch);

  const handle: TimerHandle = timers.repeat(() => {
    for (const socket of server.clients) {
      if (!answered.has(socket)) {
        socket.terminate();
        continue;
      }
      answered.delete(socket);
      socket.ping();
    }
  }, period);

  return {
    stop: () => timers.stopRepeat(handle),
  };
}
