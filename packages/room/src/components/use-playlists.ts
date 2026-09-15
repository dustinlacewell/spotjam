import { useCallback, useState } from "react";
import type { ParsedTrack } from "../lib/spotify-link";
import {
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  type Playlist,
} from "../lib/playlists";
import { loadPlaylists, savePlaylists } from "../lib/playlists-store";

export interface PlaylistsApi {
  playlists: Playlist[];
  create(name: string): void;
  /** Creates a playlist already holding tracks, and returns its new id. */
  createWithTracks(name: string, tracks: ParsedTrack[]): string;
  remove(id: string): void;
  rename(id: string, name: string): void;
  /** Inserts just before `beforeTrackId`, or at the end when null or not found. */
  insertTracks(id: string, tracks: ParsedTrack[], beforeTrackId: string | null): void;
  removeTrack(id: string, index: number): void;
  shuffle(id: string): void;
  /** Shares a playlist with the room, or takes it back. */
  setPublic(id: string, isPublic: boolean): void;
}

/**
 * Holds this install's playlists. State starts from localStorage and every
 * mutation writes straight back, so the pure ops in lib/playlists stay the only
 * place that knows how a playlist changes.
 */
export function usePlaylists(): PlaylistsApi {
  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);

  const apply = useCallback((update: (lists: Playlist[]) => Playlist[]) => {
    setPlaylists((lists) => {
      const next = update(lists);
      if (next !== lists) savePlaylists(next);
      return next;
    });
  }, []);

  return {
    playlists,
    create: useCallback((name: string) => apply((l) => createPlaylist(l, name)), [apply]),
    createWithTracks: useCallback(
      (name: string, tracks: ParsedTrack[]) => {
        // The id is minted here, not inside the updater, so the caller can
        // select the new playlist without waiting for state to land.
        const id = crypto.randomUUID();
        apply((l) => createPlaylistWithTracks(l, name, tracks, id));
        return id;
      },
      [apply],
    ),
    remove: useCallback((id: string) => apply((l) => deletePlaylist(l, id)), [apply]),
    rename: useCallback(
      (id: string, name: string) => apply((l) => renamePlaylist(l, id, name)),
      [apply],
    ),
    insertTracks: useCallback(
      (id: string, tracks: ParsedTrack[], beforeTrackId: string | null) =>
        apply((l) => insertTracksIntoPlaylist(l, id, tracks, beforeTrackId)),
      [apply],
    ),
    removeTrack: useCallback(
      (id: string, index: number) => apply((l) => removeTrackFromPlaylist(l, id, index)),
      [apply],
    ),
    shuffle: useCallback((id: string) => apply((l) => shufflePlaylist(l, id)), [apply]),
    setPublic: useCallback(
      (id: string, isPublic: boolean) => apply((l) => setPlaylistPublic(l, id, isPublic)),
      [apply],
    ),
  };
}
