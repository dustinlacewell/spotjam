// @spotjam/protocol — shared wire contract between desktop client and server.
//
// Both sides import from here so the contract cannot drift. The server trusts
// nothing but signatures: every client message arrives in a signed envelope,
// and the envelope's public key is the only author the server recognises.

export const PROTOCOL_VERSION = 1;

export {
  canonicalize,
  canonicalBytes,
  type CanonicalValue,
} from "./canonical.js";

export {
  generateKeypair,
  publicKeyOf,
  signBytes,
  verifyBytes,
  isPublicKeyHex,
  isSignatureHex,
  shortKey,
  type Keypair,
  type PublicKeyHex,
  type SignatureHex,
} from "./identity.js";

export {
  seal,
  open,
  isEnvelope,
  REPLAY_WINDOW_MS,
  type Envelope,
  type OpenFailure,
  type OpenResult,
} from "./envelope.js";

export {
  isOp,
  type Op,
  type OpType,
  type QueueItem,
  type JoinRoomOp,
  type LeaveRoomOp,
  type SetBroadcastingOp,
  type EnqueueOp,
  type RemoveOp,
  type MoveManyOp,
  type SendToTopOp,
  type ShuffleOp,
  type ClearQueueOp,
  type SetPausedOp,
  type SeekOp,
  type SkipOp,
  type PlaylistTrack,
  type SharedPlaylist,
  type SetPublicPlaylistsOp,
  type ViewPlaylistsOp,
} from "./ops.js";

export {
  NULL_POINTER,
  type Participant,
  type SessionEntry,
  type PlaybackPointer,
  type RoomSnapshot,
  type RoomStateEvent,
  type RegisteredEvent,
  type RoomSummary,
  type RoomListEvent,
  type RoomDetailEvent,
  type ErrorEvent,
  type PlaylistsEvent,
  type ServerEvent,
  type ServerEventType,
} from "./events.js";

export { endsAt, positionAt, settleOnce } from "./pointer.js";

export { appendUniqueTracks, moveMany, type HasTrackId, type HasId } from "./tracks.js";

export {
  isQuery,
  type Query,
  type WatchRoomsQuery,
  type UnwatchRoomsQuery,
  type WatchRoomQuery,
  type UnwatchRoomQuery,
} from "./queries.js";

export {
  isValidUsername,
  normalizeUsername,
  USERNAME_MIN,
  USERNAME_MAX,
  type RegisterPayload,
  type HelloPayload,
  type AuthPayload,
  type IdentityRecord,
} from "./registration.js";
