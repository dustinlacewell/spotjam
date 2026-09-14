import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { broadcasterOrder, projectSessionQueue } from "./session-queue";
import {
  NULL_POINTER,
  pausedPointer,
  resumedPointer,
  seekedPointer,
  startedPointer,
} from "./playback-clock";
import type { ParsedTrack } from "./spotify-link";
import { shuffled } from "./shuffle";

export interface QueueItem {
  id: string;
  uri: string;
  trackId: string;
  /** Display name of the user who added it. */
  addedBy: string;
}

export interface PlaybackPointer {
  itemId: string | null;
  /** userId of the broadcaster who owns the playing item. */
  ownerId: string | null;
  uri: string | null;
  /** Epoch ms at which the track was at position 0. Valid while playing. */
  startedAtEpochMs: number;
  isPaused: boolean;
  /** Position frozen at pause time. Valid only while paused. */
  pausedAtOffsetMs: number;
}

/** One peer's sample of where its local player sits in the pointer's item. */
export interface Progress {
  itemId: string;
  positionMs: number;
  durationMs: number;
  sampledAtEpochMs: number;
}

export interface Participant {
  clientId: number;
  userId: string;
  username: string;
  broadcasting: boolean;
  isMe: boolean;
}

export interface ConnectionStatus {
  socket: "connecting" | "connected" | "disconnected";
  synced: boolean;
}

export interface SessionEntry {
  item: QueueItem;
  ownerId: string;
  ownerName: string;
}

const RELAY_URL = "wss://yjs.ldlework.com";

/**
 * A joined room: a shared Yjs document synced over a WebSocket relay.
 * Holds one queue per user plus the single playback pointer everyone
 * follows, and projects them into the round-robin session queue. Pure
 * shared state — no Spotify here; SyncDriver does that.
 */
export class Room {
  readonly doc: Y.Doc;
  readonly myUserId: string;

  private readonly queues: Y.Map<Y.Array<QueueItem>>;
  private readonly playback: Y.Map<unknown>;
  private readonly provider: WebsocketProvider;

  private status: ConnectionStatus = { socket: "connecting", synced: false };
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly unsubscribes: Array<() => void> = [];

  constructor(roomId: string, identity: { userId: string; username: string }) {
    this.myUserId = identity.userId;
    this.doc = new Y.Doc();
    this.queues = this.doc.getMap<Y.Array<QueueItem>>("queues");
    this.playback = this.doc.getMap("playback");
    this.provider = new WebsocketProvider(RELAY_URL, `spotjam-${roomId}`, this.doc);
    this.provider.awareness.setLocalState({
      userId: identity.userId,
      username: identity.username,
      broadcasting: false,
    });
    this.wireStatusEvents();
    this.wireChangeEvents();
  }

  // --- subscriptions -------------------------------------------------

  private wireStatusEvents(): void {
    this.provider.on("status", ({ status }: { status: ConnectionStatus["socket"] }) => {
      this.updateStatus({ socket: status });
    });
    this.provider.on("sync", (synced: boolean) => {
      this.updateStatus({ synced });
    });
    this.provider.on("connection-error", (event: unknown) => {
      console.error("spotjam: websocket connection error", this.provider.url, event);
    });
    this.provider.on("connection-close", (event: unknown) => {
      console.warn("spotjam: websocket closed", this.provider.url, event);
    });
  }

  private wireChangeEvents(): void {
    const fire = () => this.emitChange();
    this.queues.observeDeep(fire);
    this.playback.observe(fire);
    this.provider.awareness.on("change", fire);
    this.unsubscribes.push(
      () => this.queues.unobserveDeep(fire),
      () => this.playback.unobserve(fire),
      () => this.provider.awareness.off("change", fire),
    );
  }

  private updateStatus(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.statusListeners) listener(this.status);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Fires after any change to queues, playback, or awareness. Re-read via the getters. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  // --- participants / awareness --------------------------------------

  /** Everyone currently in the room, including this client, by clientId ascending. */
  participants(): Participant[] {
    const me = this.doc.clientID;
    const found: Participant[] = [];
    for (const [clientId, raw] of this.provider.awareness.getStates()) {
      const state = raw as Record<string, unknown>;
      if (typeof state?.userId !== "string") continue;
      found.push({
        clientId,
        userId: state.userId,
        username: readUsername(state),
        broadcasting: state.broadcasting === true,
        isMe: clientId === me,
      });
    }
    return found.sort((a, b) => a.clientId - b.clientId);
  }

  /** Client ids that take part in election: only peers running this protocol (they publish a userId). */
  connectedClientIds(): number[] {
    return this.participants().map((p) => p.clientId);
  }

  isBroadcasting(): boolean {
    return this.provider.awareness.getLocalState()?.broadcasting === true;
  }

  setBroadcasting(on: boolean): void {
    this.provider.awareness.setLocalStateField("broadcasting", on);
  }

  /** Publishes where my local player is, so peers can render a progress bar. */
  setMyProgress(progress: Progress | null): void {
    this.provider.awareness.setLocalStateField("progress", progress);
  }

  /**
   * Progress reported for the current pointer item by the lowest-clientId peer
   * that has one. Null when the pointer is empty or nobody reports on it.
   */
  leaderProgress(): Progress | null {
    const itemId = this.getPlaybackPointer().itemId;
    if (itemId === null) return null;
    let best: Progress | null = null;
    let bestClientId = Number.POSITIVE_INFINITY;
    for (const [clientId, raw] of this.provider.awareness.getStates()) {
      if (clientId >= bestClientId) continue;
      const progress = readProgress((raw as Record<string, unknown>)?.progress);
      if (!progress || progress.itemId !== itemId) continue;
      best = progress;
      bestClientId = clientId;
    }
    return best;
  }

  // --- queues --------------------------------------------------------

  queueOf(userId: string): QueueItem[] {
    return this.queues.get(userId)?.toArray() ?? [];
  }

  myQueue(): QueueItem[] {
    return this.queueOf(this.myUserId);
  }

  addToMyQueue(item: QueueItem): void {
    this.doc.transact(() => {
      this.myQueueArray().push([item]);
    });
  }

  /** Appends many items in one transaction, so peers see the whole batch at once. */
  appendToMyQueue(items: QueueItem[]): void {
    if (items.length === 0) return;
    this.doc.transact(() => {
      this.myQueueArray().push(items);
    });
  }

  /** Swaps my whole queue for these items in one transaction. */
  replaceMyQueue(items: QueueItem[]): void {
    this.doc.transact(() => {
      const array = this.myQueueArray();
      if (array.length > 0) array.delete(0, array.length);
      if (items.length > 0) array.push(items);
    });
  }

  removeFromMyQueue(itemId: string): void {
    this.doc.transact(() => {
      const array = this.queues.get(this.myUserId);
      if (!array) return;
      const index = indexOfItem(array, itemId);
      if (index !== -1) array.delete(index, 1);
    });
  }

  moveInMyQueue(fromIndex: number, toIndex: number): void {
    this.doc.transact(() => {
      const array = this.queues.get(this.myUserId);
      if (!array) return;
      const items = array.toArray();
      if (fromIndex < 0 || fromIndex >= items.length) return;
      const target = clamp(toIndex, 0, items.length - 1);
      if (target === fromIndex) return;
      const moved = items[fromIndex];
      array.delete(fromIndex, 1);
      array.insert(target, [moved]);
    });
  }

  sendToTopOfMyQueue(itemId: string): void {
    this.doc.transact(() => {
      const array = this.queues.get(this.myUserId);
      if (!array) return;
      const index = indexOfItem(array, itemId);
      if (index <= 0) return;
      const moved = array.get(index);
      array.delete(index, 1);
      array.insert(0, [moved]);
    });
  }

  /** Randomizes my queue's play order for every peer, in one transaction. */
  shuffleMyQueue(): void {
    this.doc.transact(() => {
      const array = this.myQueueArray();
      if (array.length < 2) return;
      const items = shuffled(array.toArray());
      array.delete(0, array.length);
      array.push(items);
    });
  }

  clearMyQueue(): void {
    this.doc.transact(() => {
      const array = this.queues.get(this.myUserId);
      if (array && array.length > 0) array.delete(0, array.length);
    });
  }

  /** Removes an item from any user's queue. Returns the removed item, or null if it was gone. */
  popFromQueue(userId: string, itemId: string): QueueItem | null {
    let removed: QueueItem | null = null;
    this.doc.transact(() => {
      const array = this.queues.get(userId);
      if (!array) return;
      const index = indexOfItem(array, itemId);
      if (index === -1) return;
      removed = array.get(index);
      array.delete(index, 1);
    });
    return removed;
  }

  /** This user's Y.Array, created on first write so readers never materialise empty queues. */
  private myQueueArray(): Y.Array<QueueItem> {
    const existing = this.queues.get(this.myUserId);
    if (existing) return existing;
    const created = new Y.Array<QueueItem>();
    this.queues.set(this.myUserId, created);
    return created;
  }

  // --- session projection --------------------------------------------

  sessionQueue(): SessionEntry[] {
    const broadcasters = broadcasterOrder(this.participants());
    const queues: Record<string, QueueItem[]> = {};
    for (const broadcaster of broadcasters) {
      queues[broadcaster.userId] = this.queueOf(broadcaster.userId);
    }
    return projectSessionQueue(broadcasters, queues, this.getPlaybackPointer().ownerId);
  }

  // --- playback ------------------------------------------------------

  getPlaybackPointer(): PlaybackPointer {
    return {
      itemId: (this.playback.get("itemId") as string | null) ?? null,
      ownerId: (this.playback.get("ownerId") as string | null) ?? null,
      uri: (this.playback.get("uri") as string | null) ?? null,
      startedAtEpochMs: (this.playback.get("startedAtEpochMs") as number) ?? 0,
      isPaused: (this.playback.get("isPaused") as boolean) ?? false,
      pausedAtOffsetMs: (this.playback.get("pausedAtOffsetMs") as number) ?? 0,
    };
  }

  setPlaybackPointer(pointer: PlaybackPointer): void {
    this.doc.transact(() => this.writePointer(pointer));
  }

  private writePointer(pointer: PlaybackPointer): void {
    this.playback.set("itemId", pointer.itemId);
    this.playback.set("ownerId", pointer.ownerId);
    this.playback.set("uri", pointer.uri);
    this.playback.set("startedAtEpochMs", pointer.startedAtEpochMs);
    this.playback.set("isPaused", pointer.isPaused);
    this.playback.set("pausedAtOffsetMs", pointer.pausedAtOffsetMs);
  }

  setPaused(isPaused: boolean, nowEpochMs: number = Date.now()): void {
    const current = this.getPlaybackPointer();
    const next = isPaused
      ? pausedPointer(current, nowEpochMs)
      : resumedPointer(current, nowEpochMs);
    this.setPlaybackPointer(next);
  }

  /** Moves the whole room to a position in the item that is already playing. */
  seekTo(positionMs: number, nowEpochMs: number = Date.now()): void {
    const current = this.getPlaybackPointer();
    if (current.itemId === null) return;
    this.setPlaybackPointer(seekedPointer(current, positionMs, nowEpochMs));
  }

  /**
   * Pops the projection head and points playback at it. Clears playback when
   * nothing is queued. `positionMs` says how far into the new track the player
   * already is, for the case where Spotify transitioned on its own.
   */
  advance(nowEpochMs: number = Date.now(), positionMs = 0): void {
    this.doc.transact(() => {
      const head = this.sessionQueue()[0];
      if (!head) {
        if (this.getPlaybackPointer().itemId !== null) this.writePointer(NULL_POINTER);
        return;
      }
      this.popFromQueue(head.ownerId, head.item.id);
      this.writePointer(startedPointer(head, nowEpochMs, positionMs));
    });
  }

  /** Skipping is just advancing early. */
  skip(nowEpochMs: number = Date.now()): void {
    this.advance(nowEpochMs);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.statusListeners.clear();
    this.changeListeners.clear();
    this.provider.destroy();
    this.doc.destroy();
  }
}

/**
 * Turns parsed track links into queue items. Each gets a fresh id, so the same
 * track can sit in a queue more than once and still be addressed individually.
 */
export function toQueueItems(tracks: ParsedTrack[], addedBy: string): QueueItem[] {
  return tracks.map((track) => ({
    id: crypto.randomUUID(),
    uri: track.uri,
    trackId: track.trackId,
    addedBy,
  }));
}

function indexOfItem(array: Y.Array<QueueItem>, itemId: string): number {
  return array.toArray().findIndex((item) => item.id === itemId);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Awareness carries whatever a peer wrote; accept only well-formed progress. */
function readProgress(raw: unknown): Progress | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.itemId !== "string") return null;
  if (typeof value.positionMs !== "number") return null;
  if (typeof value.durationMs !== "number") return null;
  if (typeof value.sampledAtEpochMs !== "number") return null;
  return {
    itemId: value.itemId,
    positionMs: value.positionMs,
    durationMs: value.durationMs,
    sampledAtEpochMs: value.sampledAtEpochMs,
  };
}

function readUsername(state: Record<string, unknown>): string {
  const name = state.username;
  return typeof name === "string" && name.trim() ? name : "anonymous";
}
