// Events — what the server tells clients.
//
// The server owns room state and broadcasts full snapshots. Snapshots cost
// more bytes than patches and buy back everything a patch stream needs:
// no sequence numbers, no resync on reconnect, no divergence. A room holds
// tens of tracks and a handful of people, so the trade is easy.

import type { QueueItem, SharedPlaylist } from "./ops.js";
import type { PublicKeyHex } from "./identity.js";

/** Someone in a room, as everyone else sees them. */
export interface Participant {
  pubkey: PublicKeyHex;
  username: string;
  broadcasting: boolean;
  /**
   * Bumps on every `set-public-playlists`; 0 on join.
   *
   * Public playlists stay out of the snapshot, so a viewer holding a copy has
   * no way to learn it went stale. This counter is the one thing about them the
   * snapshot does carry: when it moves, viewers re-fetch.
   */
  playlistsRevision: number;
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
  /**
   * Epoch ms at which position was zero, in the server's clock. Meaningful
   * while playing. Clients convert it with their own clock offset.
   */
  startedAtEpochMs: number;
  isPaused: boolean;
  /** Frozen position. Meaningful only while paused. */
  pausedAtOffsetMs: number;
  /** Length of the pointed track in ms; 0 when itemId is null. */
  durationMs: number;
}

export const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerPubkey: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
  durationMs: 0,
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

/** One live room, as shown in a room browser. */
export interface RoomSummary {
  roomId: string;
  listeners: number;
  /** The current pointer's track, or null when nothing is playing. */
  trackUri: string | null;
  /** When this room was first created. */
  createdAtEpochMs: number;
}

export interface RoomListEvent {
  type: "room-list";
  rooms: RoomSummary[];
}

/**
 * One watched room, for a browser peeking in without joining.
 *
 * The same snapshot a member gets, projected for the watcher — whose `myQueue`
 * is empty, because a non-member owns no queue in that room.
 */
export interface RoomDetailEvent {
  type: "room-detail";
  snapshot: RoomSnapshot;
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

/** One member's public playlists, sent to whoever asked. */
export interface PlaylistsEvent {
  type: "playlists";
  roomId: string;
  ownerPubkey: PublicKeyHex;
  playlists: SharedPlaylist[];
}

export type ServerEvent =
  | RoomStateEvent
  | RegisteredEvent
  | RoomListEvent
  | RoomDetailEvent
  | ErrorEvent
  | PlaylistsEvent;

export type ServerEventType = ServerEvent["type"];
