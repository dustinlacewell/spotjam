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
  type Progress,
  type PublicKeyHex,
  type QueueItem,
  type RoomSnapshot,
  type ServerEvent,
  type SessionEntry,
} from "@spotjam/protocol";

import type { ParsedTrack } from "./spotify-link";

/** How the socket is doing, for the status line. */
export type SocketPhase = "connecting" | "connected" | "disconnected";

export interface ConnectionStatus {
  socket: SocketPhase;
  /** True once a room snapshot has arrived, so the UI shows real data. */
  synced: boolean;
}

/**
 * Where a player actually sits, as opposed to where the pointer says playback
 * started. The broadcaster samples its own player, the server keeps the newest
 * sample, and it rides back out in every snapshot so all clients draw one bar.
 *
 * Re-exported from the protocol rather than redeclared: the wire shape is the
 * only definition, so the two cannot drift.
 */
export type { Progress };

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
  move: (roomId: string, fromIndex: number, toIndex: number): Op => ({
    type: "move",
    roomId,
    fromIndex,
    toIndex,
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
  reportProgress: (
    roomId: string,
    sample: {
      itemId: string;
      positionMs: number;
      durationMs: number;
      sampledAtEpochMs: number;
    },
  ): Op => ({
    type: "report-progress",
    roomId,
    itemId: sample.itemId,
    positionMs: sample.positionMs,
    durationMs: sample.durationMs,
    sampledAtEpochMs: sample.sampledAtEpochMs,
  }),
} as const;

/**
 * Turn parsed track links into queue items.
 *
 * Each gets a fresh id, so the same track can sit in a queue more than once and
 * still be addressed individually. Ownership is not carried: the envelope's key
 * is the author, and the server stamps `ownerPubkey` itself.
 */
export function toQueueItems(tracks: ParsedTrack[]): QueueItem[] {
  return tracks.map((track) => ({
    id: crypto.randomUUID(),
    uri: track.uri,
    trackId: track.trackId,
  }));
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
 */
export function reduce(view: RoomView, event: ServerEvent): RoomView {
  switch (event.type) {
    case "room-state":
      return {
        ...view,
        snapshot: event.snapshot,
        status: { ...view.status, synced: true },
        // A good snapshot means the room is working; a stale error would
        // otherwise sit in the UI forever.
        lastError: null,
      };

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

    case "error":
      return { ...view, lastError: describeError(event.code, event.message) };
  }
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

export function pointerOf(view: RoomView): PlaybackPointer {
  return view.snapshot?.pointer ?? NULL_POINTER;
}

/** The broadcaster's newest sample, as relayed by the server. */
export function progressOf(view: RoomView): Progress | null {
  return view.snapshot?.progress ?? null;
}

/**
 * One participant's queue.
 *
 * A snapshot carries only the recipient's own queue, so another person's is
 * unknowable and reads as empty. The session queue is where their tracks show.
 */
export function queueOf(view: RoomView, pubkey: PublicKeyHex, me: PublicKeyHex): QueueItem[] {
  return pubkey === me ? myQueueOf(view) : [];
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
