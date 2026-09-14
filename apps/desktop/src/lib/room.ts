// RoomClient — the socket shell around the pure core in room-client.ts.
//
// All the I/O lives here: the WebSocket, the reconnect timer, and the calls to
// the Rust signer. Every decision — which op a gesture becomes, what an event
// does to the view — belongs to room-client.ts, so this file stays a sequence
// of named steps with no logic of its own.
//
// The server owns room state. This class sends signed ops and renders whatever
// snapshot comes back; it derives nothing.

import type {
  AuthPayload,
  Envelope,
  Op,
  Participant,
  PlaybackPointer,
  PublicKeyHex,
  QueueItem,
  RoomSnapshot,
  ServerEvent,
  SessionEntry,
} from "@spotjam/protocol";
import type { CanonicalValue } from "@spotjam/protocol";

import { IdentityClient, identityClient } from "./identity";
import {
  INITIAL_VIEW,
  backoffMs,
  helloPayload,
  isBroadcasting,
  myQueueOf,
  ops,
  parseServerEvent,
  participantsOf,
  pointerOf,
  queueOf,
  reduce,
  registerPayload,
  sessionQueueOf,
  usernameOf,
  type ConnectionStatus,
  type Progress,
  type RoomError,
  type RoomView,
} from "./room-client";

export type {
  ConnectionStatus,
  Progress,
  RoomError,
  SocketPhase,
} from "./room-client";
export { toQueueItems } from "./room-client";
export type {
  Participant,
  PlaybackPointer,
  QueueItem,
  RoomSnapshot,
  SessionEntry,
} from "@spotjam/protocol";

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

export interface RoomOptions {
  /** Overridden in tests; defaults to the real WebSocket. */
  socketFactory?: SocketFactory;
  url?: string;
  identity?: IdentityClient;
  /** Injected so tests need no real timers for backoff. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * A joined room, backed by the spotjam server.
 *
 * Mutating methods are fire-and-forget: they sign an op, send it, and wait for
 * the snapshot the server broadcasts back. Nothing is applied locally first,
 * so the UI can never disagree with the server about what happened.
 */
export class RoomClient {
  readonly roomId: string;
  readonly myPubkey: PublicKeyHex;

  #view: RoomView = INITIAL_VIEW;
  #socket: SocketLike | null = null;
  #reconnectAttempt = 0;
  #reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  /** Bumped per connection so a late reply from a dead socket is ignored. */
  #generation = 0;
  /** How far this connection's greeting has got. Reset on every reconnect. */
  #handshake: "greeting" | "registering" | "done" = "greeting";
  /** Our own sample of the local player. The server keeps no progress. */
  #myProgress: Progress | null = null;

  readonly #username: string;
  readonly #url: string;
  readonly #identity: IdentityClient;
  readonly #socketFactory: SocketFactory;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  readonly #now: () => number;

  readonly #statusListeners = new Set<(status: ConnectionStatus) => void>();
  readonly #changeListeners = new Set<() => void>();

  constructor(
    roomId: string,
    identity: { publicKey: PublicKeyHex; username: string },
    options: RoomOptions = {},
  ) {
    this.roomId = roomId;
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
    this.#setStatus({ socket: "connected", synced: false });
    void this.#send(helloPayload(), generation);
  }

  /**
   * Carry the handshake forward on what the server actually said.
   *
   * `registered` means the key is known and the room can be asked for.
   * `unknown-identity` while greeting means this key has never claimed a name,
   * so the one stored on this machine is registered and the server answers
   * with `registered` — which lands back here and does the join.
   */
  #advanceHandshake(event: ServerEvent, generation: number): void {
    if (this.#handshake === "done") return;

    if (event.type === "registered") {
      this.#handshake = "done";
      void this.#send(ops.joinRoom(this.roomId), generation);
      return;
    }

    if (
      event.type === "error" &&
      event.code === "unknown-identity" &&
      this.#handshake === "greeting"
    ) {
      this.#handshake = "registering";
      void this.#send(registerPayload(this.#username), generation);
    }
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

  /** A frame from a socket we have already replaced is not this room's news. */
  #onMessage(data: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    if (typeof data !== "string") return;
    const event = parseServerEvent(data);
    if (event === null) return;

    if (event.type === "error") {
      console.warn("spotjam: server error", event.code, event.message);
    }

    this.#advanceHandshake(event, generation);

    const next = reduce(this.#view, event);
    if (next !== this.#view) {
      this.#view = next;
      this.#emitChange();
    }
  }

  /**
   * Sign a payload and put it on the wire.
   *
   * False means it did not go: the socket died, the generation moved on, or
   * the signer refused. Callers use that to abandon a stale handshake.
   */
  async #send(payload: Op | AuthPayload, generation: number): Promise<boolean> {
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

  /** Fire an op at the current connection. */
  #sendOp(op: Op): void {
    void this.#send(op, this.#generation);
  }

  // --- subscriptions -------------------------------------------------

  #setStatus(status: ConnectionStatus): void {
    this.#view = { ...this.#view, status };
    for (const listener of this.#statusListeners) listener(status);
  }

  #emitChange(): void {
    for (const listener of this.#changeListeners) listener();
  }

  getStatus(): ConnectionStatus {
    return this.#view.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /** Fires after every snapshot or error. Re-read through the getters. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  // --- reading the room ----------------------------------------------

  snapshot(): RoomSnapshot | null {
    return this.#view.snapshot;
  }

  lastError(): RoomError | null {
    return this.#view.lastError;
  }

  participants(): Participant[] {
    return participantsOf(this.#view);
  }

  sessionQueue(): SessionEntry[] {
    return sessionQueueOf(this.#view);
  }

  myQueue(): QueueItem[] {
    return myQueueOf(this.#view);
  }

  queueOf(pubkey: PublicKeyHex): QueueItem[] {
    return queueOf(this.#view, pubkey, this.myPubkey);
  }

  getPlaybackPointer(): PlaybackPointer {
    return pointerOf(this.#view);
  }

  isBroadcasting(): boolean {
    return isBroadcasting(this.#view, this.myPubkey);
  }

  usernameOf(pubkey: PublicKeyHex | null): string {
    return usernameOf(this.#view, pubkey);
  }

  /**
   * Our own view of the local player.
   *
   * The server stores no progress, so this never leaves the machine. It feeds
   * this client's progress bar and nothing else.
   */
  myProgress(): Progress | null {
    return this.#myProgress;
  }

  // --- queue ops -----------------------------------------------------

  appendToMyQueue(items: QueueItem[]): void {
    if (items.length === 0) return;
    this.#sendOp(ops.enqueue(this.roomId, items));
  }

  addToMyQueue(item: QueueItem): void {
    this.appendToMyQueue([item]);
  }

  /** Clear, then enqueue: the protocol has no single replace op. */
  replaceMyQueue(items: QueueItem[]): void {
    this.#sendOp(ops.clearQueue(this.roomId));
    if (items.length > 0) this.#sendOp(ops.enqueue(this.roomId, items));
  }

  removeFromMyQueue(itemId: string): void {
    this.#sendOp(ops.remove(this.roomId, itemId));
  }

  moveInMyQueue(fromIndex: number, toIndex: number): void {
    this.#sendOp(ops.move(this.roomId, fromIndex, toIndex));
  }

  sendToTopOfMyQueue(itemId: string): void {
    this.#sendOp(ops.sendToTop(this.roomId, itemId));
  }

  shuffleMyQueue(): void {
    this.#sendOp(ops.shuffle(this.roomId));
  }

  clearMyQueue(): void {
    this.#sendOp(ops.clearQueue(this.roomId));
  }

  // --- playback ------------------------------------------------------

  setBroadcasting(on: boolean): void {
    this.#sendOp(ops.setBroadcasting(this.roomId, on));
  }

  setPaused(isPaused: boolean): void {
    this.#sendOp(ops.setPaused(this.roomId, isPaused));
  }

  seekTo(positionMs: number): void {
    this.#sendOp(ops.seek(this.roomId, positionMs));
  }

  skip(): void {
    this.#sendOp(ops.skip(this.roomId));
  }

  /**
   * Record where the local player is, and tell the server.
   *
   * The sample is kept locally because the progress bar needs it; the op goes
   * out because the protocol defines it, even though the server treats it as
   * advisory and keeps nothing.
   */
  setMyProgress(progress: Progress | null): void {
    this.#myProgress = progress;
    if (progress === null) return;
    this.#sendOp(ops.reportProgress(this.roomId, progress.positionMs));
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
    this.#changeListeners.clear();
  }
}

/** The name the app uses. `Room` kept its meaning; only the transport changed. */
export { RoomClient as Room };
