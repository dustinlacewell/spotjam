// The Room port — what the app layer may ask of a joined room.
//
// The desktop app's RoomClient implements it over a WebSocket; a test or a
// second shell can implement it any other way. Nothing above this interface
// knows about sockets, signing, or Tauri.

import type {
  Participant,
  PlaybackPointer,
  Progress,
  PublicKeyHex,
  QueueItem,
  SessionEntry,
  SharedPlaylist,
} from "@spotjam/protocol";

import type { ConnectionStatus, RoomError } from "../lib/room-client";

/**
 * A joined room.
 *
 * Mutating methods are fire-and-forget: the implementation sends the intent
 * and waits for the room's own answer. Callers re-read through the getters
 * after `onChange` fires; they never apply a change locally.
 */
export interface Room {
  readonly myPubkey: PublicKeyHex;

  // --- subscriptions ---------------------------------------------------

  getStatus(): ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  onChange(listener: () => void): () => void;

  // --- reading the room ------------------------------------------------

  participants(): Participant[];
  sessionQueue(): SessionEntry[];
  myQueue(): QueueItem[];
  queueOf(pubkey: PublicKeyHex): QueueItem[];
  getPlaybackPointer(): PlaybackPointer;
  myProgress(): Progress | null;
  lastError(): RoomError | null;
  isBroadcasting(): boolean;

  // --- queue ops -------------------------------------------------------

  appendToMyQueue(items: QueueItem[]): void;
  replaceMyQueue(items: QueueItem[]): void;
  removeFromMyQueue(itemId: string): void;
  moveInMyQueue(fromIndex: number, toIndex: number): void;
  sendToTopOfMyQueue(itemId: string): void;
  shuffleMyQueue(): void;
  clearMyQueue(): void;

  // --- shared playlists --------------------------------------------------
  //
  // The room holds a copy of your public playlists only while you are in it,
  // and hands one member's set to whoever asks. `playlistsOf` reads the last
  // answer; ask for a fresh one with `viewPlaylists`.

  /** Replace the whole public set. Never a patch. */
  setPublicPlaylists(playlists: SharedPlaylist[]): void;
  viewPlaylists(ownerPubkey: PublicKeyHex): void;
  playlistsOf(ownerPubkey: PublicKeyHex): SharedPlaylist[];

  // --- playback --------------------------------------------------------

  setBroadcasting(on: boolean): void;
  setPaused(isPaused: boolean): void;
  seekTo(positionMs: number): void;
  skip(): void;
}
