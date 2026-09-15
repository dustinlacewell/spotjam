// Ports — what the app layer asks of its surroundings.

export type { Room } from "./ports/room";

// A whole room in memory — the same port, with no server behind it.

export { MockRoom } from "./mock/mock-room";
export type { MockParticipant, MockPlaying, MockRoomSeed } from "./mock/mock-room";

export type { TrackInfo, TrackMetadataSource } from "./ports/track-metadata";

export { PlaylistFetchError, isGone } from "./ports/playlist-service";
export type {
  ImportedPlaylist,
  PlaylistFetchFailure,
  PlaylistService,
} from "./ports/playlist-service";

// Room client core — pure op building and snapshot folding.

export {
  BASE_RECONNECT_MS,
  INITIAL_VIEW,
  MAX_RECONNECT_MS,
  backoffMs,
  describeError,
  helloPayload,
  isBroadcasting,
  isServerEvent,
  myQueueOf,
  ops,
  parseServerEvent,
  participantsOf,
  peerPlaylistsOf,
  pointerOf,
  progressOf,
  queueOf,
  queueToRestore,
  reduce,
  registerPayload,
  sessionQueueOf,
  toQueueItems,
  usernameOf,
} from "./lib/room-client";
export type {
  ConnectionStatus,
  Progress,
  RoomError,
  RoomView,
  SocketPhase,
} from "./lib/room-client";

// Progress.

export { displayedProgress, formatClock } from "./lib/progress";
export type { PlaybackProgress } from "./lib/progress";

// Spotify links.

export {
  parseSpotifyLinks,
  parseSpotifyPlaylistLink,
  parseSpotifyTrackLink,
  parseSpotifyTrackLinks,
} from "./lib/spotify-link";
export type { ParsedLinks, ParsedPlaylist, ParsedTrack } from "./lib/spotify-link";

// Playlists.

export {
  canAddTracks,
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  isEditable,
  linkedPlaylistId,
  reconcileLinked,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  toSharedPlaylists,
  unlinkPlaylist,
} from "./lib/playlists";
export type { Playlist, PlaylistSource } from "./lib/playlists";

// The local copy of a member's queue, so a server restart does not lose it.

export { loadQueue, saveQueue } from "./lib/queue-store";

// Drag and drop.

export { INTERNAL_DRAG_MIME } from "./lib/drop-links";
export type { DropData } from "./lib/drop-links";

// Services — the shell-supplied ports the room UI reads from context.

export { RoomServicesProvider, useRoomServices } from "./services";
export type { RoomServices } from "./services";

// Components.

export { QueueView } from "./components/QueueView";
export { Sidebar } from "./components/Sidebar";
export { NowPlaying } from "./components/NowPlaying";
export { QueueItemCard } from "./components/QueueItemCard";
export { SessionQueueList } from "./components/SessionQueueList";
export { useTrackMetadata } from "./components/use-track-metadata";
