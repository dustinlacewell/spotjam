// Ops — what a client asks the server to do.
//
// Every op travels inside a signed envelope, so the server always knows which
// key authored it. Ops never carry an author field: the envelope's pubkey is
// the author, and a payload that claimed otherwise would simply be ignored.

import type { PublicKeyHex } from "./identity.js";

/** A track queued by someone, as it exists in a room. */
export interface QueueItem {
  /** Fresh per add; identifies this entry, not the track. */
  id: string;
  /** spotify:track:... */
  uri: string;
  trackId: string;
}

export interface JoinRoomOp {
  type: "join-room";
  roomId: string;
}

export interface LeaveRoomOp {
  type: "leave-room";
  roomId: string;
}

/** Announce whether this client is playing audio for the room. */
export interface SetBroadcastingOp {
  type: "set-broadcasting";
  roomId: string;
  broadcasting: boolean;
}

export interface EnqueueOp {
  type: "enqueue";
  roomId: string;
  items: QueueItem[];
}

export interface RemoveOp {
  type: "remove";
  roomId: string;
  itemId: string;
}

/**
 * Reorder a block of items in one move: `itemIds` names the moved entries
 * (their own relative order survives the move, not the array order here),
 * `beforeItemId` names the entry the block lands before, or `null` for the
 * end of the queue.
 */
export interface MoveManyOp {
  type: "move-many";
  roomId: string;
  itemIds: string[];
  beforeItemId: string | null;
}

export interface SendToTopOp {
  type: "send-to-top";
  roomId: string;
  itemId: string;
}

export interface ShuffleOp {
  type: "shuffle";
  roomId: string;
}

export interface ClearQueueOp {
  type: "clear-queue";
  roomId: string;
}

/** Transport controls. The server owns the pointer; these are requests. */
export interface SetPausedOp {
  type: "set-paused";
  roomId: string;
  paused: boolean;
}

export interface SeekOp {
  type: "seek";
  roomId: string;
  positionMs: number;
}

export interface SkipOp {
  type: "skip";
  roomId: string;
}

/**
 * Report where the local player actually sits.
 *
 * This is how a listener's progress bar tracks the broadcaster's real playback
 * rather than a local guess: the broadcaster samples Spotify, the server keeps
 * the newest sample, and it rides back out in every snapshot. `itemId` scopes
 * the sample to one track so a stale one cannot bleed across an advance.
 */
export interface ReportProgressOp {
  type: "report-progress";
  roomId: string;
  itemId: string;
  positionMs: number;
  durationMs: number;
  /** Sender's clock when the sample was taken; receivers extrapolate from it. */
  sampledAtEpochMs: number;
}

/** One track inside a shared playlist. No queue identity; that is minted on enqueue. */
export interface PlaylistTrack {
  uri: string;
  trackId: string;
}

/** A playlist as its owner shows it to the room. */
export interface SharedPlaylist {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

/** Replace the sender's public playlists. The full set every time, never a patch. */
export interface SetPublicPlaylistsOp {
  type: "set-public-playlists";
  roomId: string;
  playlists: SharedPlaylist[];
}

/** Ask for one member's public playlists. Answered with a `playlists` event to the sender only. */
export interface ViewPlaylistsOp {
  type: "view-playlists";
  roomId: string;
  ownerPubkey: PublicKeyHex;
}

export type Op =
  | JoinRoomOp
  | LeaveRoomOp
  | SetBroadcastingOp
  | EnqueueOp
  | RemoveOp
  | MoveManyOp
  | SendToTopOp
  | ShuffleOp
  | ClearQueueOp
  | SetPausedOp
  | SeekOp
  | SkipOp
  | ReportProgressOp
  | SetPublicPlaylistsOp
  | ViewPlaylistsOp;

export type OpType = Op["type"];

const OP_TYPES: ReadonlySet<string> = new Set<OpType>([
  "join-room",
  "leave-room",
  "set-broadcasting",
  "enqueue",
  "remove",
  "move-many",
  "send-to-top",
  "shuffle",
  "clear-queue",
  "set-paused",
  "seek",
  "skip",
  "report-progress",
  "set-public-playlists",
  "view-playlists",
]);

/** Structural check only; the server still validates fields per op type. */
export function isOp(value: unknown): value is Op {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Record<string, unknown>;
  return typeof op.type === "string" && OP_TYPES.has(op.type);
}
