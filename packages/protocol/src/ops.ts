// Ops — what a client asks the server to do.
//
// Every op travels inside a signed envelope, so the server always knows which
// key authored it. Ops never carry an author field: the envelope's pubkey is
// the author, and a payload that claimed otherwise would simply be ignored.

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

export interface MoveOp {
  type: "move";
  roomId: string;
  fromIndex: number;
  toIndex: number;
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

/** Report local playback progress so the server can track drift. */
export interface ReportProgressOp {
  type: "report-progress";
  roomId: string;
  positionMs: number;
}

export type Op =
  | JoinRoomOp
  | LeaveRoomOp
  | SetBroadcastingOp
  | EnqueueOp
  | RemoveOp
  | MoveOp
  | SendToTopOp
  | ShuffleOp
  | ClearQueueOp
  | SetPausedOp
  | SeekOp
  | SkipOp
  | ReportProgressOp;

export type OpType = Op["type"];

const OP_TYPES: ReadonlySet<string> = new Set<OpType>([
  "join-room",
  "leave-room",
  "set-broadcasting",
  "enqueue",
  "remove",
  "move",
  "send-to-top",
  "shuffle",
  "clear-queue",
  "set-paused",
  "seek",
  "skip",
  "report-progress",
]);

/** Structural check only; the server still validates fields per op type. */
export function isOp(value: unknown): value is Op {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Record<string, unknown>;
  return typeof op.type === "string" && OP_TYPES.has(op.type);
}
