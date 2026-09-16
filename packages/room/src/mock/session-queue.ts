// The room's play-order rules, as pure functions over plain data.
//
// These mirror the server's own functional core (apps/server/src/room-state.ts)
// so an in-memory room behaves the way a real one does: the same round-robin
// interleave, the same rotation cursor, the same pointer settling. Nothing here
// touches a socket, a clock of its own, or randomness.

import {
  NULL_POINTER,
  type Participant,
  type PlaybackPointer,
  type PublicKeyHex,
  type QueueItem,
  type SessionEntry,
} from "@spotjam/protocol";

/** One person in the mock room. Their queue is theirs alone. */
export interface MockMember {
  pubkey: PublicKeyHex;
  username: string;
  broadcasting: boolean;
  queue: QueueItem[];
}

/**
 * A mock room at one moment.
 *
 * `order` fixes turn order — it is seed order — and `turnCursor` remembers how
 * far the rotation has run, so advancing resumes it rather than restarting.
 */
export interface MockState {
  members: readonly MockMember[];
  order: readonly PublicKeyHex[];
  pointer: PlaybackPointer;
  turnCursor: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Members in turn order, each pubkey once. */
export function membersInOrder(state: MockState): MockMember[] {
  const byKey = new Map(state.members.map((member) => [member.pubkey, member]));
  const seen = new Set<PublicKeyHex>();
  const members: MockMember[] = [];
  for (const pubkey of state.order) {
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    const member = byKey.get(pubkey);
    if (member !== undefined) members.push(member);
  }
  return members;
}

export function memberOf(state: MockState, pubkey: PublicKeyHex): MockMember | undefined {
  return state.members.find((member) => member.pubkey === pubkey);
}

export function listParticipants(state: MockState): Participant[] {
  return membersInOrder(state).map((member) => ({
    pubkey: member.pubkey,
    username: member.username,
    broadcasting: member.broadcasting,
    // MockRoom owns the real counts and layers them over this projection.
    playlistsRevision: 0,
  }));
}

/**
 * Interleave broadcasters' queues round-robin: everyone's first track, then
 * everyone's second, and so on. A member who runs out drops out of later rounds
 * rather than padding them.
 */
export function buildSessionQueue(state: MockState): SessionEntry[] {
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

export function broadcastersWithTracks(state: MockState): PublicKeyHex[] {
  return membersInOrder(state)
    .filter((member) => member.broadcasting && member.queue.length > 0)
    .map((member) => member.pubkey);
}

export function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function withMember(state: MockState, member: MockMember): MockState {
  return {
    ...state,
    members: state.members.map((existing) =>
      existing.pubkey === member.pubkey ? member : existing,
    ),
  };
}

/**
 * Apply a transform to one member's queue, then let the pointer settle.
 *
 * Every queue op goes through here, which is why a queue change can clear a
 * pointer that no longer has a broadcaster behind it.
 */
export function mapQueue(
  state: MockState,
  pubkey: PublicKeyHex,
  transform: (queue: readonly QueueItem[]) => readonly QueueItem[],
): MockState {
  const member = memberOf(state, pubkey);
  if (member === undefined) return state;
  return settlePointer(withMember(state, { ...member, queue: [...transform(member.queue)] }));
}

export function setBroadcasting(
  state: MockState,
  pubkey: PublicKeyHex,
  broadcasting: boolean,
): MockState {
  const member = memberOf(state, pubkey);
  if (member === undefined) return state;
  return settlePointer(withMember(state, { ...member, broadcasting }));
}

/**
 * Clear the pointer once nobody is broadcasting.
 *
 * Playback belongs to the broadcasters. When the last one stops, the room has
 * no audio source and must not keep pointing at a track.
 */
export function settlePointer(state: MockState): MockState {
  const anyBroadcasting = membersInOrder(state).some((member) => member.broadcasting);
  if (anyBroadcasting || state.pointer.itemId === null) return state;
  return { ...state, pointer: NULL_POINTER };
}

/**
 * Play the next track: take the head of the next broadcaster's queue.
 *
 * Turn order rotates across broadcasting members with tracks. When nobody
 * broadcasting has anything left, the pointer clears — the exhaustion case.
 */
export function advance(state: MockState, now: number): MockState {
  const feeders = broadcastersWithTracks(state);
  if (feeders.length === 0) return { ...state, pointer: NULL_POINTER };

  const next = feeders[state.turnCursor % feeders.length];
  if (next === undefined) return { ...state, pointer: NULL_POINTER };

  const member = memberOf(state, next);
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
      // The pointer carries its track's length, as the server's does: it is
      // what every client reads the bar and the track end out of.
      durationMs: head.durationMs,
    },
  };
}

/**
 * Start playback once a broadcaster has something to play.
 *
 * The mirror of `settlePointer`: that one clears a pointer the room can no
 * longer justify, this one fills a null pointer the room can now feed.
 */
export function settleStart(state: MockState, now: number): MockState {
  if (state.pointer.itemId !== null) return state;
  if (broadcastersWithTracks(state).length === 0) return state;
  return advance(state, now);
}

// ---------------------------------------------------------------------------
// Pointer arithmetic
// ---------------------------------------------------------------------------

/** Pause freezes the elapsed offset; resume rebases the start time. */
export function setPaused(state: MockState, paused: boolean, now: number): MockState {
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

export function seek(state: MockState, positionMs: number, now: number): MockState {
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

/**
 * Where the pointer's track sits right now, clamped to its length.
 *
 * Paused playback reads its frozen offset; playing reads the wall clock.
 */
export function positionOf(pointer: PlaybackPointer, now: number, durationMs: number): number {
  const raw = pointer.isPaused ? pointer.pausedAtOffsetMs : now - pointer.startedAtEpochMs;
  return Math.min(Math.max(0, raw), Math.max(0, durationMs));
}
