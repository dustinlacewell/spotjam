// MockRoom — a whole room in memory.
//
// It implements the same `Room` port the desktop's socket-backed client does,
// so the real UI can render against seeded data with no server, no identity and
// no network: the marketing site's live demo, and a fixture for any test that
// wants a room rather than a socket.
//
// All the rules live in session-queue.ts as pure functions on plain data. This
// class is the imperative shell around them: it holds the current state, hands
// out the getters, and tells listeners when the state moved.

import {
  NULL_POINTER,
  type Participant,
  type PlaybackPointer,
  type Progress,
  type PublicKeyHex,
  type QueueItem,
  type SessionEntry,
  type SharedPlaylist,
} from "@spotjam/protocol";

import type { ConnectionStatus, RoomError } from "../lib/room-client";
import type { Room } from "../ports/room";
import { shuffled } from "../lib/shuffle";
import {
  advance,
  buildSessionQueue,
  listParticipants,
  mapQueue,
  memberOf,
  positionOf,
  seek,
  setBroadcasting,
  setPaused,
  settleStart,
  type MockState,
} from "./session-queue";

/** How long a track runs when the seed does not say. */
export const DEFAULT_DURATION_MS = 210_000;

/** A seeded participant, with the queue they brought. */
export interface MockParticipant {
  pubkey: string;
  username: string;
  broadcasting: boolean;
  queue: QueueItem[];
  /** What this person shares with the room. Default none. */
  publicPlaylists?: SharedPlaylist[];
}

/** Where playback starts, for one seeded item. */
export interface MockPlaying {
  itemId: string;
  durationMs: number;
  /** Position at seed time. Default 0. */
  positionMs?: number;
  /** Default false. */
  paused?: boolean;
}

export interface MockRoomSeed {
  /** Whose room this is. Must match one of `participants`. */
  myPubkey: string;
  participants: MockParticipant[];
  /** Which session-queue item is playing. undefined = first session entry if any; null = nothing. */
  playing?: MockPlaying | null;
  /** Track lengths by item id, for items that become current later. */
  durations?: Record<string, number>;
  /** Default Date.now. Inject one to make progress deterministic. */
  clock?: () => number;
  /** Randomness for `shuffleMyQueue`. Default Math.random. */
  rng?: () => number;
}

/**
 * A joined room held entirely in memory.
 *
 * Unlike the socket client, mutators apply immediately — there is no server to
 * wait for — but the contract is the same: callers re-read through the getters
 * after `onChange` fires.
 */
export class MockRoom implements Room {
  readonly myPubkey: PublicKeyHex;

  #state: MockState;
  #durations: Map<string, number>;
  /** The room's copy of everyone's public playlists, keyed by owner. */
  readonly #playlists = new Map<PublicKeyHex, SharedPlaylist[]>();
  /** How many times each owner has replaced their set. Seeding does not count. */
  readonly #revisions = new Map<PublicKeyHex, number>();

  readonly #clock: () => number;
  readonly #rng: () => number;
  readonly #statusListeners = new Set<(status: ConnectionStatus) => void>();
  readonly #changeListeners = new Set<() => void>();

  constructor(seed: MockRoomSeed) {
    this.myPubkey = seed.myPubkey;
    this.#clock = seed.clock ?? Date.now;
    this.#rng = seed.rng ?? Math.random;
    this.#durations = new Map(Object.entries(seed.durations ?? {}));
    for (const participant of seed.participants) {
      if (participant.publicPlaylists) {
        this.#playlists.set(participant.pubkey, participant.publicPlaylists);
      }
    }
    this.#state = seedState(seed);
    this.#state = startPlayback(this.#state, seed, this.#clock(), this.#durations);
  }

  // --- subscriptions -------------------------------------------------

  /** A mock room is always up: there is nothing to connect to or sync with. */
  getStatus(): ConnectionStatus {
    return { socket: "connected", synced: true };
  }

  /** Fires once on subscribe with the current status, as the real client does. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  // --- reading the room ----------------------------------------------

  participants(): Participant[] {
    // Revisions live beside the playlists themselves, not on MockMember, so
    // they are layered on here rather than threaded through session-queue.
    return listParticipants(this.#state).map((participant) => ({
      ...participant,
      playlistsRevision: this.#revisions.get(participant.pubkey) ?? 0,
    }));
  }

  sessionQueue(): SessionEntry[] {
    return buildSessionQueue(this.#state);
  }

  myQueue(): QueueItem[] {
    return this.queueOf(this.myPubkey);
  }

  /** A mock room knows everyone's queue, so a peer's is real rather than empty. */
  queueOf(pubkey: PublicKeyHex): QueueItem[] {
    return [...(memberOf(this.#state, pubkey)?.queue ?? [])];
  }

  getPlaybackPointer(): PlaybackPointer {
    return this.#state.pointer;
  }

  /** Derived from the pointer and the clock: there is no player to sample. */
  myProgress(): Progress | null {
    const pointer = this.#state.pointer;
    if (pointer.itemId === null) return null;
    const now = this.#clock();
    const durationMs = this.#durationOf(pointer.itemId);
    return {
      itemId: pointer.itemId,
      positionMs: positionOf(pointer, now, durationMs),
      durationMs,
      sampledAtEpochMs: now,
    };
  }

  /** Nothing here can fail, so there is never an error to report. */
  lastError(): RoomError | null {
    return null;
  }

  isBroadcasting(): boolean {
    return memberOf(this.#state, this.myPubkey)?.broadcasting ?? false;
  }

  usernameOf(pubkey: PublicKeyHex | null): string {
    if (pubkey === null) return "someone";
    return memberOf(this.#state, pubkey)?.username ?? "someone";
  }

  // --- queue ops -----------------------------------------------------

  appendToMyQueue(items: QueueItem[]): void {
    if (items.length === 0) return;
    this.#mapMyQueue((queue) => [...queue, ...items]);
  }

  replaceMyQueue(items: QueueItem[]): void {
    this.#mapMyQueue(() => [...items]);
  }

  removeFromMyQueue(itemId: string): void {
    this.#mapMyQueue((queue) => queue.filter((item) => item.id !== itemId));
  }

  /** Out-of-range indices leave the queue untouched, as the server has it. */
  moveInMyQueue(fromIndex: number, toIndex: number): void {
    this.#mapMyQueue((queue) => {
      if (!isIndexInRange(fromIndex, queue.length) || !isIndexInRange(toIndex, queue.length)) {
        return queue;
      }
      const next = [...queue];
      const [moved] = next.splice(fromIndex, 1);
      if (moved === undefined) return queue;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  sendToTopOfMyQueue(itemId: string): void {
    this.#mapMyQueue((queue) => {
      const index = queue.findIndex((item) => item.id === itemId);
      if (index < 0) return queue;
      const next = [...queue];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return queue;
      return [moved, ...next];
    });
  }

  shuffleMyQueue(): void {
    this.#mapMyQueue((queue) => shuffled(queue, this.#rng));
  }

  clearMyQueue(): void {
    this.#mapMyQueue(() => []);
  }

  // --- shared playlists ----------------------------------------------

  setPublicPlaylists(playlists: SharedPlaylist[]): void {
    this.#playlists.set(this.myPubkey, [...playlists]);
    this.#revisions.set(this.myPubkey, (this.#revisions.get(this.myPubkey) ?? 0) + 1);
    this.#emitChange();
  }

  /**
   * A mock room already holds every member's set, so there is nothing to ask
   * for. The call stays on the port so the UI is written the same either way.
   */
  viewPlaylists(_ownerPubkey: PublicKeyHex): void {
    // Answered synchronously by playlistsOf.
  }

  playlistsOf(ownerPubkey: PublicKeyHex): SharedPlaylist[] {
    return this.#playlists.get(ownerPubkey) ?? [];
  }

  // --- playback ------------------------------------------------------

  setBroadcasting(on: boolean): void {
    this.#commit(setBroadcasting(this.#state, this.myPubkey, on));
  }

  setPaused(isPaused: boolean): void {
    this.#commit(setPaused(this.#state, isPaused, this.#clock()));
  }

  seekTo(positionMs: number): void {
    this.#commit(seek(this.#state, positionMs, this.#clock()));
  }

  /** Advance the pointer, dropping the played track from its owner's queue. */
  skip(): void {
    this.#commit(advance(this.#state, this.#clock()));
  }

  // --- teardown ------------------------------------------------------

  destroy(): void {
    this.#statusListeners.clear();
    this.#changeListeners.clear();
  }

  // --- internals -----------------------------------------------------

  #mapMyQueue(transform: (queue: readonly QueueItem[]) => readonly QueueItem[]): void {
    this.#commit(mapQueue(this.#state, this.myPubkey, transform));
  }

  /**
   * Take the new state, fill a pointer the room can now feed, and tell everyone.
   *
   * `settleStart` runs on every commit for the same reason the server runs it
   * on every op: enqueueing into an empty broadcasting room starts playback.
   */
  #commit(next: MockState): void {
    this.#state = settleStart(next, this.#clock());
    this.#emitChange();
  }

  #emitChange(): void {
    for (const listener of this.#changeListeners) listener();
  }

  #durationOf(itemId: string): number {
    return this.#durations.get(itemId) ?? DEFAULT_DURATION_MS;
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedState(seed: MockRoomSeed): MockState {
  return {
    members: seed.participants.map((participant) => ({
      pubkey: participant.pubkey,
      username: participant.username,
      broadcasting: participant.broadcasting,
      queue: [...participant.queue],
    })),
    order: seed.participants.map((participant) => participant.pubkey),
    pointer: NULL_POINTER,
    turnCursor: 0,
  };
}

/**
 * Put the seed's chosen track on the pointer.
 *
 * `null` means play nothing. `undefined` means the head of the session queue,
 * which is what a freshly started room does. A named item is advanced to by
 * replaying the rotation until the pointer lands on it, so the queues and the
 * turn cursor end up exactly where a real room's would.
 */
function startPlayback(
  state: MockState,
  seed: MockRoomSeed,
  now: number,
  durations: Map<string, number>,
): MockState {
  const playing = seed.playing;
  if (playing === null) return state;

  if (playing === undefined) return settleStart(state, now);

  durations.set(playing.itemId, playing.durationMs);

  const target = advanceTo(state, playing.itemId, now);
  if (target === null) return state;

  const positionMs = Math.max(0, playing.positionMs ?? 0);
  const paused = playing.paused ?? false;
  return {
    ...target,
    pointer: paused
      ? { ...target.pointer, isPaused: true, pausedAtOffsetMs: positionMs }
      : { ...target.pointer, isPaused: false, startedAtEpochMs: now - positionMs },
  };
}

/** Advance until the pointer names `itemId`, or null when it never does. */
function advanceTo(state: MockState, itemId: string, now: number): MockState | null {
  let current = state;
  for (let step = 0; step < buildSessionQueue(state).length; step++) {
    current = advance(current, now);
    if (current.pointer.itemId === itemId) return current;
    if (current.pointer.itemId === null) return null;
  }
  return null;
}

function isIndexInRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}
