// Room client core — message construction and snapshot folding.
//
// Everything here is pure: payloads in, payloads out. No socket, no clock, no
// identity. That is what makes the interesting parts — which op a UI gesture
// becomes, what a server event does to the view — testable without a network.
//
// The client is a thin projection of server state. The server decides play
// order, the pointer, and who plays next; nothing in this file recomputes any
// of it.

import {
  NULL_POINTER,
  type AuthPayload,
  type Op,
  type Participant,
  type PlaybackPointer,
  type PublicKeyHex,
  type QueueItem,
  type RoomSnapshot,
  type ServerEvent,
  type SessionEntry,
  type SharedPlaylist,
} from "@spotjam/protocol";

import { foldSample, offsetOf, serverNow } from "./clock-offset";
import type { OffsetSample } from "./clock-offset";
import type { ParsedTrack } from "./spotify-link";

/** How the socket is doing, for the status line. */
export type SocketPhase = "connecting" | "connected" | "disconnected";

export interface ConnectionStatus {
  socket: SocketPhase;
  /** True once a room snapshot has arrived, so the UI shows real data. */
  synced: boolean;
}

/**
 * The last snapshot, plus the fields a fresh client has before one arrives.
 *
 * Holding the whole snapshot rather than destructured copies keeps the getters
 * honest: they read the server's answer, they do not assemble their own.
 */
export interface RoomView {
  snapshot: RoomSnapshot | null;
  status: ConnectionStatus;
  /** The most recent typed error the server sent, or null. */
  lastError: RoomError | null;
  /**
   * Other members' public playlists, as last answered, keyed by their owner.
   *
   * The server sends these only when asked, so a key is absent until this
   * client views that person's page.
   */
  peerPlaylists: Record<PublicKeyHex, SharedPlaylist[]>;
  /**
   * How far the server's clock sits ahead of this machine's, in ms.
   *
   * Null until a snapshot has been folded in. Every playback position on
   * screen is computed from the pointer against the server clock, so this is
   * what makes a local `Date.now()` usable for reading one.
   */
  clockOffsetMs: number | null;
  /**
   * The recent `serverTime` samples the offset was estimated from.
   *
   * Each sample is biased low by the frame's network hop (the server stamps
   * `serverTime` when it sends), so the offset is the *largest* sample in the
   * window rather than a blend. The window is kept so a future sample can
   * revise the estimate; only its max is exposed as `clockOffsetMs`.
   */
  offsetSamples: OffsetSample[];
}

/** A server error, narrowed to what the UI needs to say about it. */
export interface RoomError {
  code: ServerErrorCode;
  message: string;
  /** Copy for the user. A skewed clock reads very differently from a bug. */
  humanMessage: string;
}

type ServerErrorCode = Extract<ServerEvent, { type: "error" }>["code"];

export const INITIAL_VIEW: RoomView = {
  snapshot: null,
  status: { socket: "connecting", synced: false },
  lastError: null,
  peerPlaylists: {},
  clockOffsetMs: null,
  offsetSamples: [],
};

// ---------------------------------------------------------------------------
// Outgoing payloads
// ---------------------------------------------------------------------------

/**
 * Greet the server with an identity it already knows.
 *
 * `hello` is always tried first: the key is the account, and a key that has
 * registered needs nothing else. Registration is the fallback, not the norm.
 */
export function helloPayload(): AuthPayload {
  return { type: "hello" };
}

export function registerPayload(username: string): AuthPayload {
  return { type: "register", username };
}

/** Every mutating gesture in the UI becomes exactly one of these. */
export const ops = {
  joinRoom: (roomId: string): Op => ({ type: "join-room", roomId }),
  leaveRoom: (roomId: string): Op => ({ type: "leave-room", roomId }),
  setBroadcasting: (roomId: string, broadcasting: boolean): Op => ({
    type: "set-broadcasting",
    roomId,
    broadcasting,
  }),
  enqueue: (roomId: string, items: QueueItem[]): Op => ({ type: "enqueue", roomId, items }),
  remove: (roomId: string, itemId: string): Op => ({ type: "remove", roomId, itemId }),
  moveMany: (roomId: string, itemIds: string[], beforeItemId: string | null): Op => ({
    type: "move-many",
    roomId,
    itemIds,
    beforeItemId,
  }),
  sendToTop: (roomId: string, itemId: string): Op => ({ type: "send-to-top", roomId, itemId }),
  shuffle: (roomId: string): Op => ({ type: "shuffle", roomId }),
  clearQueue: (roomId: string): Op => ({ type: "clear-queue", roomId }),
  setPaused: (roomId: string, paused: boolean): Op => ({ type: "set-paused", roomId, paused }),
  seek: (roomId: string, positionMs: number): Op => ({
    type: "seek",
    roomId,
    positionMs: Math.max(0, Math.round(positionMs)),
  }),
  skip: (roomId: string): Op => ({ type: "skip", roomId }),
  setPublicPlaylists: (roomId: string, playlists: SharedPlaylist[]): Op => ({
    type: "set-public-playlists",
    roomId,
    playlists,
  }),
  viewPlaylists: (roomId: string, ownerPubkey: PublicKeyHex): Op => ({
    type: "view-playlists",
    roomId,
    ownerPubkey,
  }),
} as const;

/**
 * Turn parsed track links into queue items.
 *
 * Each gets a fresh id, so the same track can sit in a queue more than once and
 * still be addressed individually. Ownership is not carried: the envelope's key
 * is the author, and the server stamps `ownerPubkey` itself.
 *
 * A track's length is not in its link, so it is looked up. The server advances
 * the pointer on durations alone, which is why `durationMs` is required and
 * why a track whose length could not be resolved is dropped rather than sent
 * as zero: a zero-length track would expire the instant it started.
 */
export function toQueueItems(tracks: DurationedTrack[]): QueueItem[] {
  return tracks
    .filter((track) => track.durationMs > 0)
    .map((track) => ({
      id: crypto.randomUUID(),
      uri: track.uri,
      trackId: track.trackId,
      durationMs: track.durationMs,
    }));
}

/** A parsed track whose length has been resolved. */
export interface DurationedTrack extends ParsedTrack {
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Incoming events
// ---------------------------------------------------------------------------

/** True when the value has the shape of a server event. */
export function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "room-state" ||
    type === "registered" ||
    type === "room-list" ||
    type === "room-detail" ||
    type === "playlists" ||
    type === "error"
  );
}

/** Parse a raw frame. Null when it is not something the protocol defines. */
export function parseServerEvent(raw: string): ServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isServerEvent(parsed) ? parsed : null;
}

/**
 * Fold one server event into the view.
 *
 * Pure and total: it returns the next view and never throws, so a surprising
 * frame cannot take the room down. An unchanged view is returned by identity,
 * which lets the shell skip a needless re-render.
 *
 * `localNow` is this machine's clock at the moment the frame arrived. It is
 * passed in rather than read so this stays pure; only a `room-state` uses it,
 * to fold the snapshot's `serverTime` into the clock offset.
 */
export function reduce(view: RoomView, event: ServerEvent, localNow: number): RoomView {
  switch (event.type) {
    case "room-state": {
      // The offset estimate is the largest sample in the window: samples are
      // biased low by their network hop, so the least-delayed one is the
      // least biased. See clock-offset.ts.
      const offsetSamples = foldSample(
        view.offsetSamples,
        event.snapshot.serverTime,
        localNow,
      );
      return {
        ...view,
        snapshot: event.snapshot,
        status: { ...view.status, synced: true },
        clockOffsetMs: offsetOf(offsetSamples),
        offsetSamples,
        // A good snapshot means the room is working; a stale error would
        // otherwise sit in the UI forever.
        lastError: null,
        // Someone who left takes their playlists with them. Keeping the copy
        // would show a rejoiner the set they had last time, since a rejoin
        // starts the room's own copy empty again.
        peerPlaylists: retainMembers(view.peerPlaylists, event.snapshot.participants),
      };
    }

    case "registered":
      // Nothing to store: the snapshot carries the username the server chose,
      // and the shell handles the join that follows.
      return view;

    case "room-list":
      // The lobby's concern, not a joined room's: nothing here reads it.
      return view;

    case "room-detail":
      // A room the browser is watching, which is not this client's room even
      // when the ids match. Folding it in would let a peek overwrite the
      // member's own view, whose `myQueue` a watcher's snapshot does not have.
      return view;

    case "playlists":
      return {
        ...view,
        peerPlaylists: { ...view.peerPlaylists, [event.ownerPubkey]: event.playlists },
      };

    case "error":
      return { ...view, lastError: describeError(event.code, event.message) };
  }
}

/** Keep only the cached playlist sets whose owner is still in the room. */
function retainMembers(
  cached: Record<PublicKeyHex, SharedPlaylist[]>,
  participants: Participant[],
): Record<PublicKeyHex, SharedPlaylist[]> {
  const present = new Set(participants.map((p) => p.pubkey));
  const kept = Object.entries(cached).filter(([pubkey]) => present.has(pubkey));
  // Same contents means same object, so the shell can skip a re-render.
  if (kept.length === Object.keys(cached).length) return cached;
  return Object.fromEntries(kept);
}

/**
 * Turn a typed error code into something a person can act on.
 *
 * `stale-envelope` is the one worth its own sentence: it almost always means
 * the machine's clock is wrong, which no amount of retrying will fix.
 */
export function describeError(code: ServerErrorCode, message: string): RoomError {
  return { code, message, humanMessage: humanMessageFor(code) };
}

function humanMessageFor(code: ServerErrorCode): string {
  switch (code) {
    case "stale-envelope":
      return "This machine's clock is off, so the server rejected the message. Sync your system clock and rejoin.";
    case "unknown-identity":
      return "The server does not know this key yet.";
    case "username-taken":
      return "That name is already taken by another key.";
    case "invalid-username":
      return "That name is not allowed.";
    case "bad-signature":
      return "The server refused a signature from this identity.";
    case "replay":
      return "The server saw that message twice.";
    case "not-in-room":
      return "You are not in that room any more.";
    case "malformed":
      return "The server could not read that message.";
    case "internal":
      return "The server hit an internal error.";
  }
}

// ---------------------------------------------------------------------------
// Reading the view
// ---------------------------------------------------------------------------
//
// Every getter below is a lookup into the last snapshot. None of them computes
// play order, rotation, or the pointer: the server already decided all three.

export function participantsOf(view: RoomView): Participant[] {
  return view.snapshot?.participants ?? [];
}

export function sessionQueueOf(view: RoomView): SessionEntry[] {
  return view.snapshot?.sessionQueue ?? [];
}

export function myQueueOf(view: RoomView): QueueItem[] {
  return view.snapshot?.myQueue ?? [];
}

/**
 * What of a locally stored queue is worth sending back after a join.
 *
 * A fresh server knows nothing: its restart wiped every member's queue, and
 * the first snapshot after the rejoin shows an empty `myQueue`. That is the
 * one case where the stored copy is the better truth, so it goes back.
 *
 * A server that still holds the queue wins. Its copy has seen every op since
 * the stored one was written -- removes, moves, skips -- so restoring on top
 * of it would resurrect tracks the member already played or dropped.
 */
export function queueToRestore(stored: QueueItem[], snapshot: RoomSnapshot): QueueItem[] {
  return snapshot.myQueue.length === 0 ? stored : [];
}

export function pointerOf(view: RoomView): PlaybackPointer {
  return view.snapshot?.pointer ?? NULL_POINTER;
}

/**
 * This instant in the server's clock.
 *
 * Before the first snapshot there is no offset to apply, so local time stands
 * in. Nothing is playing then either — the pointer is null until a snapshot
 * arrives — so nothing reads a position out of the guess.
 */
export function serverNowOf(view: RoomView, localNow: number): number {
  return serverNow(view.clockOffsetMs ?? 0, localNow);
}

/**
 * One participant's queue.
 *
 * My own queue comes from the snapshot's `myQueue`, which holds my tracks even
 * when I am not broadcasting. A peer's queue is read off the session queue: the
 * server interleaves members round-robin, so filtering by owner recovers that
 * member's own order. A member who is not broadcasting therefore reads as empty
 * -- the server sends nobody's private queue.
 */
export function queueOf(view: RoomView, pubkey: PublicKeyHex, me: PublicKeyHex): QueueItem[] {
  if (pubkey === me) return myQueueOf(view);
  return sessionQueueOf(view)
    .filter((entry) => entry.ownerPubkey === pubkey)
    .map((entry) => entry.item);
}

/**
 * One member's public playlists, as last answered.
 *
 * Empty until this client has asked for them, which is the same as that member
 * sharing nothing — both mean "there is nothing of theirs to show".
 */
export function peerPlaylistsOf(view: RoomView, pubkey: PublicKeyHex): SharedPlaylist[] {
  return view.peerPlaylists[pubkey] ?? [];
}

export function isBroadcasting(view: RoomView, me: PublicKeyHex): boolean {
  return participantsOf(view).find((p) => p.pubkey === me)?.broadcasting ?? false;
}

export function usernameOf(view: RoomView, pubkey: PublicKeyHex | null): string {
  if (pubkey === null) return "someone";
  return participantsOf(view).find((p) => p.pubkey === pubkey)?.username ?? "someone";
}

// ---------------------------------------------------------------------------
// Reconnect backoff
// ---------------------------------------------------------------------------

export const BASE_RECONNECT_MS = 500;
export const MAX_RECONNECT_MS = 15_000;

/**
 * How long to wait before retry number `attempt` (0-based).
 *
 * Exponential, capped. Deterministic so a test can assert the schedule; the
 * shell adds no jitter because a room holds a handful of clients, not a fleet.
 */
export function backoffMs(attempt: number): number {
  const exponential = BASE_RECONNECT_MS * 2 ** Math.max(0, attempt);
  return Math.min(MAX_RECONNECT_MS, exponential);
}
