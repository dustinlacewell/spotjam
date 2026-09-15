// Server shell — sockets, HTTP health, and process wiring.
//
// Everything here is I/O. The decisions live in Session and the pure core; this
// file only moves bytes between them and a real network.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { newConnection } from "./connections.ts";
import type { IdentityStore } from "./identity-store.ts";
import { MemoryManifestStore, type ManifestStore } from "./manifest-store.ts";
import { systemClock, type Clock, type Rng } from "./ports.ts";
import { mergeManifest, parseUpdate } from "./release-manifest.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { RoomRegistry } from "./rooms.ts";
import { Session } from "./session.ts";

export interface ServerOptions {
  host?: string;
  port?: number;
  identities: IdentityStore;
  /** Where the updater manifest lives. Volatile unless given a durable one. */
  manifests?: ManifestStore;
  /**
   * The bearer token CI presents to post a manifest. Unset closes the route:
   * a server with no token configured must not accept anonymous writes.
   */
  releaseToken?: string | undefined;
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
  const manifests = options.manifests ?? new MemoryManifestStore();
  const clock = options.clock ?? systemClock;

  const session = new Session({
    rooms,
    identities: options.identities,
    replay: new ReplayGuard(),
    clock,
    rng: options.rng ?? Math.random,
  });

  const http = createServer(
    httpHandler({ manifests, releaseToken: options.releaseToken, clock }),
  );
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

interface HttpDeps {
  manifests: ManifestStore;
  releaseToken: string | undefined;
  clock: Clock;
}

/** The largest manifest worth reading; past this the body is refused unread. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The plain HTTP surface: a health probe for the tunnel, and the updater
 * manifest that the desktop client polls and CI writes.
 */
function httpHandler(deps: HttpDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.url === "/latest.json") {
      if (req.method === "GET") {
        serveManifest(deps, res);
        return;
      }
      if (req.method === "POST") {
        void receiveManifest(deps, req, res);
        return;
      }
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
}

/**
 * Serve what CI last posted.
 *
 * 204 rather than 404 when nothing is stored: Tauri reads "no content" as "no
 * update available", which is the truth before the first release.
 */
function serveManifest(deps: HttpDeps, res: ServerResponse): void {
  const manifest = deps.manifests.load();
  if (manifest === null) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 200, manifest);
}

/** Take one platform's entries from a release workflow and fold them in. */
async function receiveManifest(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (deps.releaseToken === undefined || deps.releaseToken === "") {
    sendJson(res, 503, { error: "release token not configured" });
    return;
  }
  if (!isAuthorized(req, deps.releaseToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req, MAX_MANIFEST_BYTES);
  } catch {
    sendJson(res, 413, { error: "body too large" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "malformed json" });
    return;
  }

  const update = parseUpdate(parsed);
  if (update === null) {
    sendJson(res, 400, { error: "malformed manifest" });
    return;
  }

  const merged = mergeManifest(deps.manifests.load(), update, deps.clock.now());
  deps.manifests.save(merged);
  sendJson(res, 200, merged);
}

/**
 * Compare the bearer token without leaking its length through timing.
 *
 * The token is a deploy credential, so a constant-time compare costs nothing
 * and removes the question.
 */
function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;

  const presented = Buffer.from(header.slice("Bearer ".length));
  const secret = Buffer.from(expected);
  if (presented.length !== secret.length) return false;
  return timingSafeEqual(presented, secret);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
