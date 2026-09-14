// Events — what the server tells clients.
//
// The server owns room state and broadcasts full snapshots. Snapshots cost
// more bytes than patches and buy back everything a patch stream needs:
// no sequence numbers, no resync on reconnect, no divergence. A room holds
// tens of tracks and a handful of people, so the trade is easy.

import type { QueueItem } from "./ops.js";
import type { PublicKeyHex } from "./identity.js";

/** Someone in a room, as everyone else sees them. */
export interface Participant {
  pubkey: PublicKeyHex;
  username: string;
  broadcasting: boolean;
}

/** One queued track plus who queued it. */
export interface SessionEntry {
  item: QueueItem;
  ownerPubkey: PublicKeyHex;
  ownerName: string;
}

/** What is playing, decided by the server. */
export interface PlaybackPointer {
  itemId: string | null;
  ownerPubkey: PublicKeyHex | null;
  uri: string | null;
  /** Epoch ms at which position was zero. Meaningful while playing. */
  startedAtEpochMs: number;
  isPaused: boolean;
  /** Frozen position. Meaningful only while paused. */
  pausedAtOffsetMs: number;
}

export const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerPubkey: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

/** The whole of a room, as of one moment. */
export interface RoomSnapshot {
  roomId: string;
  participants: Participant[];
  /** Play order across all broadcasting participants. */
  sessionQueue: SessionEntry[];
  /** The caller's own queue, in their order. */
  myQueue: QueueItem[];
  pointer: PlaybackPointer;
  /** Server clock at snapshot time, for drift correction. */
  serverTime: number;
}

export interface RoomStateEvent {
  type: "room-state";
  snapshot: RoomSnapshot;
}

export interface RegisteredEvent {
  type: "registered";
  pubkey: PublicKeyHex;
  username: string;
}

export interface ErrorEvent {
  type: "error";
  /** Machine-readable; UI maps it to copy. */
  code:
    | "bad-signature"
    /** Timestamp outside the replay window — usually a skewed client clock. */
    | "stale-envelope"
    | "replay"
    | "unknown-identity"
    | "username-taken"
    | "invalid-username"
    | "not-in-room"
    | "malformed"
    | "internal";
  message: string;
}

export type ServerEvent = RoomStateEvent | RegisteredEvent | ErrorEvent;

export type ServerEventType = ServerEvent["type"];
