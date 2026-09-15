// RoomClient — one joined room, layered on a shared Connection.
//
// All the socket I/O — the WebSocket, the reconnect timer, the handshake —
// lives in Connection, which the app builds once and keeps for as long as it
// runs. This class only tracks membership in one room: it asks the shared
// connection to join, filters the connection's events down to this room's
// snapshots, and turns method calls into signed ops. Every decision — which
// op a gesture becomes, what an event does to the view — belongs to
// room-client.ts, so this file stays a sequence of named steps with no logic
// of its own.
//
// The server owns room state. This class sends signed ops and renders whatever
// snapshot comes back; it derives nothing.

import type {
  Op,
  Participant,
  PlaybackPointer,
  PublicKeyHex,
  QueueItem,
  RoomSnapshot,
  ServerEvent,
  SessionEntry,
  SharedPlaylist,
} from "@spotjam/protocol";

import type { Connection } from "./connection";
import {
  INITIAL_VIEW,
  isBroadcasting,
  loadQueue,
  myQueueOf,
  ops,
  queueToRestore,
  saveQueue,
  participantsOf,
  peerPlaylistsOf,
  pointerOf,
  progressOf,
  queueOf,
  reduce,
  sessionQueueOf,
  usernameOf,
  type ConnectionStatus,
  type Progress,
  type Room,
  type RoomError,
  type RoomView,
} from "@spotjam/room";

export type {
  ConnectionStatus,
  Progress,
  RoomError,
  SocketPhase,
} from "@spotjam/room";
export { toQueueItems } from "@spotjam/room";
export type {
  Participant,
  PlaybackPointer,
  QueueItem,
  RoomSnapshot,
  SessionEntry,
} from "@spotjam/protocol";
export type { SocketLike, SocketFactory, ConnectionOptions } from "./connection";
export { Connection, DEFAULT_SERVER_URL } from "./connection";

/**
 * A joined room, backed by a shared Connection.
 *
 * Mutating methods are fire-and-forget: they sign an op, send it, and wait for
 * the snapshot the server broadcasts back. Nothing is applied locally first,
 * so the UI can never disagree with the server about what happened.
 */
export class RoomClient implements Room {
  readonly roomId: string;
  readonly myPubkey: PublicKeyHex;

  #view: RoomView = INITIAL_VIEW;
  #closed = false;
  /**
   * Our own sample of the local player. Used only until the server echoes a
   * sample back, which it does whenever this client is the broadcaster.
   */
  #myProgress: Progress | null = null;

  readonly #connection: Connection;
  readonly #unsubscribeEvent: () => void;
  readonly #unsubscribeReady: () => void;
  readonly #unsubscribeStatus: () => void;

  readonly #statusListeners = new Set<(status: ConnectionStatus) => void>();
  readonly #changeListeners = new Set<() => void>();

  constructor(connection: Connection, roomId: string) {
    this.roomId = roomId;
    this.myPubkey = connection.myPubkey;
    this.#connection = connection;

    this.#unsubscribeEvent = connection.onEvent((event) => this.#onEvent(event));
    this.#unsubscribeReady = connection.onReady(() => this.#join());
    this.#unsubscribeStatus = connection.onStatus(() => this.#onSocketStatusChange());

    // The connection may already be past its handshake by the time this room
    // is constructed (a second room joined on an existing session).
    if (connection.isReady()) this.#join();
    this.#setSynced(false);
  }

  // --- membership ------------------------------------------------------

  #join(): void {
    console.info("spotjam: joining", this.roomId);
    this.#connection.send(ops.joinRoom(this.roomId));
  }

  /**
   * Keep this install's copy of our queue, and hand it back to a server that
   * lost it.
   *
   * The server holds queues in memory only, so a deploy wipes every one of
   * them. Every client then reconnects, rejoins, and sees an empty queue. The
   * first snapshot after each join -- the one that flips `synced` on -- is
   * where that shows, so that is where the stored copy is offered back.
   *
   * Saving happens after the restore decision, never before: the empty
   * snapshot from a restarted server would otherwise overwrite the stored
   * queue a moment before it is read.
   */
  #persistQueue(snapshot: RoomSnapshot, wasSynced: boolean): void {
    if (!wasSynced && this.#view.status.synced) {
      const restore = queueToRestore(loadQueue(this.roomId), snapshot);
      if (restore.length > 0) this.#sendOp(ops.enqueue(this.roomId, restore));
    }
    saveQueue(this.roomId, snapshot.myQueue);
  }

  // --- events ------------------------------------------------------------

  /** Only this room's news, filtered out of every event the connection sees. */
  #onEvent(event: ServerEvent): void {
    if (event.type === "room-state" && event.snapshot.roomId !== this.roomId) return;
    // A shared connection may back more than one room; a playlist answer names
    // the room it came from, so another room's must not fold into this view.
    if (event.type === "playlists" && event.roomId !== this.roomId) return;

    if (event.type === "room-state" && !this.#view.status.synced) {
      console.info("spotjam: first snapshot", event.snapshot.roomId);
    }

    const previousStatus = this.#view.status;
    const reduced = reduce(this.#view, event);
    // reduce() only decides `synced`; the socket half always mirrors the
    // shared connection's own live status, which it does not know about.
    const socketChanged = previousStatus.socket !== this.#liveSocket();
    if (reduced === this.#view && !socketChanged) return;

    this.#view = { ...reduced, status: { ...reduced.status, socket: this.#liveSocket() } };
    if (event.type === "room-state") {
      this.#persistQueue(event.snapshot, previousStatus.synced);
    }
    // Status listeners are a separate channel from onChange, so without this
    // the UI never hears that the socket or the room's sync state changed.
    if (this.#view.status.socket !== previousStatus.socket || this.#view.status.synced !== previousStatus.synced) {
      for (const listener of this.#statusListeners) listener(this.#view.status);
    }
    this.#emitChange();
  }

  /**
   * The shared connection's socket dropped or came back. This room was not
   * necessarily re-joined yet — `onReady` handles that — but the socket half
   * of the status changed regardless, and a snapshot is no longer current
   * once the socket is gone.
   */
  #onSocketStatusChange(): void {
    this.#setSynced(this.#connection.getStatus().socket === "disconnected" ? false : this.#view.status.synced);
  }

  #liveSocket(): ConnectionStatus["socket"] {
    return this.#connection.getStatus().socket;
  }

  #setSynced(synced: boolean): void {
    const status: ConnectionStatus = { socket: this.#liveSocket(), synced };
    if (status.socket === this.#view.status.socket && status.synced === this.#view.status.synced) {
      return;
    }
    this.#view = { ...this.#view, status };
    for (const listener of this.#statusListeners) listener(status);
  }

  /** Fire an op at the shared connection. */
  #sendOp(op: Op): void {
    this.#connection.send(op);
  }

  // --- subscriptions -------------------------------------------------

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
   * Where the current track actually sits.
   *
   * The broadcaster's sample, as relayed by the server, so every client draws
   * the same bar. Our own sample stands in only until the first one arrives --
   * otherwise the bar would stall for a beat on every track change.
   */
  myProgress(): Progress | null {
    const shared = progressOf(this.#view);
    if (shared !== null) return shared;
    const pointer = this.getPlaybackPointer();
    if (pointer.itemId === null) return null;
    return this.#myProgress?.itemId === pointer.itemId ? this.#myProgress : null;
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

  // --- shared playlists ----------------------------------------------

  /** Replace the room's copy of our public set. The whole set, every time. */
  setPublicPlaylists(playlists: SharedPlaylist[]): void {
    this.#sendOp(ops.setPublicPlaylists(this.roomId, playlists));
  }

  /** Ask for one member's public playlists. The answer arrives as an event. */
  viewPlaylists(ownerPubkey: PublicKeyHex): void {
    this.#sendOp(ops.viewPlaylists(this.roomId, ownerPubkey));
  }

  playlistsOf(ownerPubkey: PublicKeyHex): SharedPlaylist[] {
    return peerPlaylistsOf(this.#view, ownerPubkey);
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
   * The sample is kept locally to cover the gap before the server echoes one
   * back, and sent on so everyone else's bar can track this player.
   */
  setMyProgress(progress: Progress | null): void {
    this.#myProgress = progress;
    if (progress === null) return;
    this.#sendOp(ops.reportProgress(this.roomId, progress));
  }

  // --- teardown ------------------------------------------------------

  /**
   * Leave the room. The shared connection is not this room's to close — it
   * may back other rooms or the lobby — so only membership and subscriptions
   * are torn down here.
   */
  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.send(ops.leaveRoom(this.roomId));
    this.#unsubscribeEvent();
    this.#unsubscribeReady();
    this.#unsubscribeStatus();
    this.#statusListeners.clear();
    this.#changeListeners.clear();
  }
}

/** The name the app uses. `Room` kept its meaning; only the transport changed. */
export { RoomClient as Room };
