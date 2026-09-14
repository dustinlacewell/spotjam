// Server shell — sockets, HTTP health, and process wiring.
//
// Everything here is I/O. The decisions live in Session and the pure core; this
// file only moves bytes between them and a real network.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { newConnection } from "./connections.ts";
import type { IdentityStore } from "./identity-store.ts";
import { systemClock, type Clock, type Rng } from "./ports.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { RoomRegistry } from "./rooms.ts";
import { Session } from "./session.ts";

export interface ServerOptions {
  host?: string;
  port?: number;
  identities: IdentityStore;
  clock?: Clock;
  rng?: Rng;
}

export interface RunningServer {
  port: number;
  rooms: RoomRegistry;
  close(): Promise<void>;
}

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 4444;

/** Start listening. Resolves once the port is bound. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const rooms = new RoomRegistry();

  const session = new Session({
    rooms,
    identities: options.identities,
    replay: new ReplayGuard(),
    clock: options.clock ?? systemClock,
    rng: options.rng ?? Math.random,
  });

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (socket: WebSocket) => {
    const connection = newConnection(socket);
    session.add(connection);

    socket.on("message", (data) => {
      session.receive(connection, data.toString());
    });
    socket.on("close", () => session.close(connection));
    // Without a handler, an ECONNRESET from ws is an unhandled error event and
    // takes the process down.
    socket.on("error", () => socket.close());
  });

  await listen(http, host, port);

  return {
    port: addressPort(http, port),
    rooms,
    close: () => shutdown(http, wss),
  };
}

/** The tunnel needs a plain endpoint to probe; websockets do not answer that. */
function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function listen(http: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
}

function addressPort(http: Server, fallback: number): number {
  const address = http.address();
  return typeof address === "object" && address !== null ? address.port : fallback;
}

function shutdown(http: Server, wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => http.close(() => resolve()));
  });
}
