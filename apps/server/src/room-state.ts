// Room state — the functional core.
//
// Every function here is pure: it takes a state and returns a new one. No
// sockets, no database, no clock, no randomness of its own. That is what makes
// the interesting behaviour — round-robin order, exhaustion, pointer clearing —
// testable without a running server.

import {
  NULL_POINTER,
  type Participant,
  type PlaybackPointer,
  type PublicKeyHex,
  type QueueItem,
  type RoomSnapshot,
  type SessionEntry,
} from "@spotjam/protocol";

import type { Rng } from "./ports.ts";

/** One person in a room. Their queue is theirs alone. */
export interface Member {
  pubkey: PublicKeyHex;
  username: string;
  broadcasting: boolean;
  queue: QueueItem[];
}

/**
 * A room at one moment.
 *
 * `order` fixes round-robin turn order: it is join order, so the rotation does
 * not reshuffle when a map is rebuilt. `turnCursor` remembers who fed the last
 * track, so `advance` resumes the rotation rather than restarting it.
 */
export interface RoomState {
  roomId: string;
  members: ReadonlyMap<PublicKeyHex, Member>;
  order: readonly PublicKeyHex[];
  pointer: PlaybackPointer;
  turnCursor: number;
}

export function emptyRoom(roomId: string): RoomState {
  return {
    roomId,
    members: new Map(),
    order: [],
    pointer: NULL_POINTER,
    turnCursor: 0,
  };
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Add a participant, or refresh the username of one already present. */
export function join(
  state: RoomState,
  pubkey: PublicKeyHex,
  username: string,
): RoomState {
  const existing = state.members.get(pubkey);
  if (existing !== undefined) {
    return withMember(state, { ...existing, username });
  }
  const member: Member = { pubkey, username, broadcasting: false, queue: [] };
  const members = new Map(state.members);
  members.set(pubkey, member);
  return { ...state, members, order: [...state.order, pubkey] };
}

/**
 * Remove a participant and everything they were feeding the room.
 *
 * Their queue goes with them, so the pointer may now name a track nobody owns.
 * `settlePointer` clears it when that happens.
 */
export function leave(state: RoomState, pubkey: PublicKeyHex): RoomState {
  if (!state.members.has(pubkey)) return state;
  const members = new Map(state.members);
  members.delete(pubkey);
  const next: RoomState = {
    ...state,
    members,
    order: state.order.filter((key) => key !== pubkey),
  };
  return settlePointer(next);
}

/** True when the room holds nobody, so the caller may discard it. */
export function isDeserted(state: RoomState): boolean {
  return state.members.size === 0;
}

export function setBroadcasting(
  state: RoomState,
  pubkey: PublicKeyHex,
  broadcasting: boolean,
): RoomState {
  const member = state.members.get(pubkey);
  if (member === undefined) return state;
  return settlePointer(withMember(state, { ...member, broadcasting }));
}

// ---------------------------------------------------------------------------
// Queue operations — each scoped to one member's own queue
// ---------------------------------------------------------------------------

export function enqueue(
  state: RoomState,
  pubkey: PublicKeyHex,
  items: readonly QueueItem[],
): RoomState {
  return mapQueue(state, pubkey, (queue) => [...queue, ...items]);
}

export function remove(
  state: RoomState,
  pubkey: PublicKeyHex,
  itemId: string,
): RoomState {
  return mapQueue(state, pubkey, (queue) => queue.filter((item) => item.id !== itemId));
}

/** Reorder within one queue. Out-of-range indices leave the queue untouched. */
export function move(
  state: RoomState,
  pubkey: PublicKeyHex,
  fromIndex: number,
  toIndex: number,
): RoomState {
  return mapQueue(state, pubkey, (queue) => {
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

export function sendToTop(
  state: RoomState,
  pubkey: PublicKeyHex,
  itemId: string,
): RoomState {
  return mapQueue(state, pubkey, (queue) => {
    const index = queue.findIndex((item) => item.id === itemId);
    if (index < 0) return queue;
    const next = [...queue];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return queue;
    return [moved, ...next];
  });
}

/** Fisher-Yates over a copy, using injected randomness. */
export function shuffle(state: RoomState, pubkey: PublicKeyHex, rng: Rng): RoomState {
  return mapQueue(state, pubkey, (queue) => {
    const next = [...queue];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const a = next[i];
      const b = next[j];
      if (a === undefined || b === undefined) continue;
      next[i] = b;
      next[j] = a;
    }
    return next;
  });
}

export function clearQueue(state: RoomState, pubkey: PublicKeyHex): RoomState {
  return mapQueue(state, pubkey, () => []);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * Play the next track: take the head of the next broadcaster's queue.
 *
 * Turn order rotates across broadcasting members with tracks, starting after
 * whoever fed the current pointer. When nobody broadcasting has anything left,
 * the pointer clears — that is the exhaustion case.
 */
export function advance(state: RoomState, now: number): RoomState {
  const feeders = broadcastersWithTracks(state);
  if (feeders.length === 0) {
    return { ...state, pointer: NULL_POINTER };
  }

  const next = feeders[state.turnCursor % feeders.length];
  if (next === undefined) return { ...state, pointer: NULL_POINTER };

  const member = state.members.get(next);
  const head = member?.queue[0];
  if (member === undefined || head === undefined) {
    return { ...state, pointer: NULL_POINTER };
  }

  const advanced = withMember(state, { ...member, queue: member.queue.slice(1) });
  return {
    ...advanced,
    turnCursor: state.turnCursor + 1,
    pointer: {
      itemId: head.id,
      ownerPubkey: member.pubkey,
      uri: head.uri,
      startedAtEpochMs: now,
      isPaused: false,
      pausedAtOffsetMs: 0,
    },
  };
}

/**
 * Pause or resume.
 *
 * Pausing freezes the elapsed offset; resuming rebases the start time so the
 * pointer keeps meaning "position zero happened at startedAtEpochMs".
 */
export function setPaused(state: RoomState, paused: boolean, now: number): RoomState {
  const { pointer } = state;
  if (pointer.itemId === null || pointer.isPaused === paused) return state;

  if (paused) {
    return {
      ...state,
      pointer: {
        ...pointer,
        isPaused: true,
        pausedAtOffsetMs: Math.max(0, now - pointer.startedAtEpochMs),
      },
    };
  }

  return {
    ...state,
    pointer: {
      ...pointer,
      isPaused: false,
      startedAtEpochMs: now - pointer.pausedAtOffsetMs,
      pausedAtOffsetMs: 0,
    },
  };
}

export function seek(state: RoomState, positionMs: number, now: number): RoomState {
  const { pointer } = state;
  if (pointer.itemId === null) return state;
  const position = Math.max(0, positionMs);

  return {
    ...state,
    pointer: pointer.isPaused
      ? { ...pointer, pausedAtOffsetMs: position }
      : { ...pointer, startedAtEpochMs: now - position, pausedAtOffsetMs: 0 },
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The room as one recipient sees it.
 *
 * `myQueue` is the recipient's own queue, which is why snapshots cannot be
 * shared between connections.
 */
export function projectSnapshot(
  state: RoomState,
  forPubkey: PublicKeyHex,
  now: number,
): RoomSnapshot {
  return {
    roomId: state.roomId,
    participants: listParticipants(state),
    sessionQueue: buildSessionQueue(state),
    myQueue: [...(state.members.get(forPubkey)?.queue ?? [])],
    pointer: state.pointer,
    serverTime: now,
  };
}

function listParticipants(state: RoomState): Participant[] {
  return membersInOrder(state).map((member) => ({
    pubkey: member.pubkey,
    username: member.username,
    broadcasting: member.broadcasting,
  }));
}

/**
 * Interleave broadcasters' queues round-robin: everyone's first track, then
 * everyone's second, and so on. A member who runs out drops out of later rounds
 * rather than padding them.
 */
function buildSessionQueue(state: RoomState): SessionEntry[] {
  const feeders = membersInOrder(state).filter(
    (member) => member.broadcasting && member.queue.length > 0,
  );
  if (feeders.length === 0) return [];

  const rotated = rotate(feeders, state.turnCursor);
  const deepest = Math.max(...rotated.map((member) => member.queue.length));
  const entries: SessionEntry[] = [];

  for (let round = 0; round < deepest; round++) {
    for (const member of rotated) {
      const item = member.queue[round];
      if (item === undefined) continue;
      entries.push({ item, ownerPubkey: member.pubkey, ownerName: member.username });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Members in turn order.
 *
 * `order` is the authority and holds each pubkey once, so two connections
 * sharing one identity get one turn, not two.
 */
function membersInOrder(state: RoomState): Member[] {
  const seen = new Set<PublicKeyHex>();
  const members: Member[] = [];
  for (const pubkey of state.order) {
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    const member = state.members.get(pubkey);
    if (member !== undefined) members.push(member);
  }
  return members;
}

function broadcastersWithTracks(state: RoomState): PublicKeyHex[] {
  return membersInOrder(state)
    .filter((member) => member.broadcasting && member.queue.length > 0)
    .map((member) => member.pubkey);
}

function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function withMember(state: RoomState, member: Member): RoomState {
  const members = new Map(state.members);
  members.set(member.pubkey, member);
  return { ...state, members };
}

function mapQueue(
  state: RoomState,
  pubkey: PublicKeyHex,
  transform: (queue: readonly QueueItem[]) => readonly QueueItem[],
): RoomState {
  const member = state.members.get(pubkey);
  if (member === undefined) return state;
  return settlePointer(withMember(state, { ...member, queue: [...transform(member.queue)] }));
}

function isIndexInRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * Clear the pointer once nobody is broadcasting.
 *
 * Playback belongs to the broadcasters. When the last one stops or leaves, the
 * room has no audio source and must not keep pointing at a track.
 */
function settlePointer(state: RoomState): RoomState {
  const anyBroadcasting = membersInOrder(state).some((member) => member.broadcasting);
  if (anyBroadcasting || state.pointer.itemId === null) return state;
  return { ...state, pointer: NULL_POINTER };
}
