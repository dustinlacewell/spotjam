// Connection — the socket shell shared by every room and the pre-join lobby.
//
// This owns exactly one thing: an authenticated line to the server. It knows
// nothing about rooms. A fresh socket greets the server, registers if the key
// is new, and from then on `send` signs and forwards whatever payload a room
// or a query hands it. Reconnects are transparent to callers: they listen for
// `onReady` to know when to re-issue anything that depended on the old socket
// (a RoomClient re-sends join-room; a lobby view could re-ask for a list).

import type {
  AuthPayload,
  Envelope,
  Op,
  PublicKeyHex,
  Query,
  RoomSummary,
  ServerEvent,
} from "@spotjam/protocol";
import type { CanonicalValue } from "@spotjam/protocol";

import { IdentityClient, identityClient } from "./identity";
import { backoffMs, helloPayload, parseServerEvent, registerPayload } from "@spotjam/room";

export type { SocketPhase, ConnectionStatus } from "@spotjam/room";
import type { ConnectionStatus } from "@spotjam/room";

/**
 * The deployed relay host. The spotjam server takes this hostname over from
 * the old Yjs relay, so existing installs keep working without a new address.
 */
export const DEFAULT_SERVER_URL = "wss://yjs.ldlework.com";

/** The socket surface this class needs. The browser's WebSocket satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export interface ConnectionOptions {
  /** Overridden in tests; defaults to the real WebSocket. */
  socketFactory?: SocketFactory;
  url?: string;
  identity?: IdentityClient;
  /** Injected so tests need no real timers for backoff. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

/**
 * One authenticated line to the server, independent of any room.
 *
 * Mutating/query calls are fire-and-forget: they sign a payload and send it.
 * Replies arrive later as events on `onEvent`; nothing here interprets a room
 * snapshot or a room list, so a RoomClient (or a lobby view) reads only the
 * events it cares about.
 */
export class Connection {
  readonly myPubkey: PublicKeyHex;

  #socket: SocketLike | null = null;
  #reconnectAttempt = 0;
  #reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  /** Bumped per connection so a late reply from a dead socket is ignored. */
  #generation = 0;
  #status: ConnectionStatus = { socket: "connecting", synced: false };
  /**
   * How far this connection's greeting has got. Reset on every reconnect.
   *
   * `failed` is terminal for the connection: the server refused the name, and
   * sending it again would only earn the same refusal.
   */
  #handshake: "greeting" | "registering" | "done" | "failed" = "greeting";

  readonly #username: string;
  readonly #url: string;
  readonly #identity: IdentityClient;
  readonly #socketFactory: SocketFactory;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  readonly #now: () => number;

  readonly #statusListeners = new Set<(status: ConnectionStatus) => void>();
  readonly #eventListeners = new Set<(event: ServerEvent) => void>();
  /** Fires each time the handshake completes, including after a reconnect. */
  readonly #readyListeners = new Set<() => void>();

  constructor(
    identity: { publicKey: PublicKeyHex; username: string },
    options: ConnectionOptions = {},
  ) {
    this.myPubkey = identity.publicKey;
    this.#username = identity.username;
    this.#url = options.url ?? DEFAULT_SERVER_URL;
    this.#identity = options.identity ?? identityClient;
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.#now = options.now ?? Date.now;

    this.#connect();
  }

  // --- connection ----------------------------------------------------

  /** Open a socket and wire it. Every reconnect comes back through here. */
  #connect(): void {
    if (this.#closed) return;
    this.#generation += 1;
    const generation = this.#generation;

    this.#setStatus({ socket: "connecting", synced: false });

    let socket: SocketLike;
    try {
      socket = this.#socketFactory(this.#url);
    } catch (error) {
      console.error("spotjam: could not open socket", this.#url, error);
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    socket.onopen = () => this.#onOpen(generation);
    socket.onmessage = (event) => this.#onMessage(event.data, generation);
    socket.onclose = () => this.#onClose(generation);
    socket.onerror = (event) => {
      // A socket error is always followed by a close, which is what actually
      // drives the reconnect. Logging here keeps the cause visible.
      console.warn("spotjam: websocket error", this.#url, event);
    };
  }

  /**
   * A fresh connection announces who we are.
   *
   * Only the greeting goes out here. What follows depends on the server's
   * answer, which arrives later over the socket, so the rest of the handshake
   * is driven from #onMessage rather than guessed at now.
   */
  #onOpen(generation: number): void {
    if (generation !== this.#generation) return;
    this.#reconnectAttempt = 0;
    this.#handshake = "greeting";
    this.#setStatus({ socket: "connected", synced: this.#status.synced });
    // The handshake has four steps across two processes and a network. Without
    // a trace of which one it reached, a stall is indistinguishable from every
    // other stall.
    console.info("spotjam: socket open", this.#url);
    void this.#send(helloPayload(), generation);
  }

  /**
   * Carry the handshake forward on what the server actually said.
   *
   * `registered` means the key is known and callers may now use the
   * connection. `unknown-identity` while greeting means this key has never
   * claimed a name, so the one stored on this machine is registered and the
   * server answers with `registered` — which lands back here.
   */
  #advanceHandshake(event: ServerEvent, generation: number): void {
    if (this.#handshake === "done") {
      return;
    }

    if (event.type === "registered") {
      this.#handshake = "done";
      console.info("spotjam: registered");
      for (const listener of this.#readyListeners) listener();
      return;
    }

    if (event.type !== "error") return;

    if (this.#isExpectedGreetingMiss(event)) {
      this.#handshake = "registering";
      void this.#send(registerPayload(this.#username), generation);
      return;
    }

    // Registration itself was refused -- a name already taken, or one the
    // server will not accept. Retrying sends the same name to the same answer,
    // so the handshake stops here and the error stands for the UI to show.
    if (this.#handshake === "registering") {
      this.#handshake = "failed";
    }
  }

  /** The first-connection miss the handshake exists to answer. */
  #isExpectedGreetingMiss(event: ServerEvent): boolean {
    return (
      event.type === "error" &&
      event.code === "unknown-identity" &&
      this.#handshake === "greeting"
    );
  }

  #onClose(generation: number): void {
    if (generation !== this.#generation) return;
    this.#socket = null;
    this.#setStatus({ socket: "disconnected", synced: false });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectHandle !== null) return;
    const delay = backoffMs(this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#reconnectHandle = this.#setTimer(() => {
      this.#reconnectHandle = null;
      this.#connect();
    }, delay);
  }

  // --- messages ------------------------------------------------------

  /** A frame from a socket we have already replaced is not this connection's news. */
  #onMessage(data: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    if (typeof data !== "string") return;
    const event = parseServerEvent(data);
    if (event === null) return;

    // `unknown-identity` while greeting is the handshake working, not failing:
    // a key registers on its first connection, and #advanceHandshake is about
    // to do exactly that. Warning here would report every first run as broken.
    if (event.type === "error" && !this.#isExpectedGreetingMiss(event)) {
      console.warn("spotjam: server error", event.code, event.message);
    }

    this.#advanceHandshake(event, generation);

    for (const listener of this.#eventListeners) listener(event);
  }

  /**
   * Sign a payload and put it on the wire.
   *
   * False means it did not go: the socket died, the generation moved on, or
   * the signer refused. Callers use that to abandon a stale handshake.
   */
  async #send(payload: Op | AuthPayload | Query, generation: number): Promise<boolean> {
    if (generation !== this.#generation) return false;

    let envelope: Envelope<CanonicalValue>;
    try {
      // Ops and auth payloads are declared as interfaces, which carry no index
      // signature, so TypeScript will not widen them to CanonicalValue. They
      // are plain JSON of exactly that shape; the protocol's own `seal` signs
      // the same values on the server side.
      const value = payload as unknown as CanonicalValue;
      envelope = await this.#identity.seal(value, this.myPubkey, this.#now());
    } catch (error) {
      console.error("spotjam: could not sign message", error);
      return false;
    }

    // Signing is async, so the socket may have gone while we waited.
    if (generation !== this.#generation) return false;
    const socket = this.#socket;
    if (socket === null) return false;

    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch (error) {
      console.warn("spotjam: could not send message", error);
      return false;
    }
  }

  /**
   * Sign and send an op or query at the current connection. Fire-and-forget.
   *
   * Silently dropped before the handshake completes: the server would answer
   * with `unknown-identity` for a room op sent ahead of registration, and a
   * caller re-issues anything that matters from `onReady` instead of racing
   * the greeting.
   */
  send(payload: Op | Query): void {
    if (!this.isReady()) return;
    void this.#send(payload, this.#generation);
  }

  // --- subscriptions -------------------------------------------------

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  getStatus(): ConnectionStatus {
    return this.#status;
  }

  /** True once the handshake has completed and the connection may be used. */
  isReady(): boolean {
    return this.#handshake === "done";
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /** Every event the server sends, unfiltered. */
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  /** Fires once the handshake completes: on first connect, and again after every reconnect. */
  onReady(listener: () => void): () => void {
    this.#readyListeners.add(listener);
    return () => {
      this.#readyListeners.delete(listener);
    };
  }

  // --- teardown ------------------------------------------------------

  destroy(): void {
    this.#closed = true;
    this.#generation += 1;
    if (this.#reconnectHandle !== null) {
      this.#clearTimer(this.#reconnectHandle);
      this.#reconnectHandle = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // Already gone. Nothing to release.
      }
    }
    this.#statusListeners.clear();
    this.#eventListeners.clear();
    this.#readyListeners.clear();
  }
}

/** True when the value has the shape of a room-list event. */
export function isRoomListEvent(
  event: ServerEvent,
): event is Extract<ServerEvent, { type: "room-list" }> {
  return event.type === "room-list";
}

/** True when the value has the shape of a watched room's snapshot push. */
export function isRoomDetailEvent(
  event: ServerEvent,
): event is Extract<ServerEvent, { type: "room-detail" }> {
  return event.type === "room-detail";
}

export type { RoomSummary };
