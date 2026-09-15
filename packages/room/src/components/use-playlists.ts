import { useCallback, useRef, useState } from "react";
import type { ParsedTrack } from "../lib/spotify-link";
import {
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  linkedPlaylistId,
  reconcileLinked,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  unlinkPlaylist,
  type Playlist,
  type PlaylistSource,
} from "../lib/playlists";
import { loadPlaylists, savePlaylists } from "../lib/playlists-store";
import { isGone, type PlaylistImporter } from "../ports/playlist-importer";

/** How a linked playlist's last sync attempt ended. */
export type SyncState = "idle" | "syncing" | "unreachable";

export interface PlaylistsApi {
  playlists: Playlist[];
  create(name: string): void;
  /** Creates a playlist already holding tracks, and returns its new id. */
  createWithTracks(name: string, tracks: ParsedTrack[], source?: PlaylistSource): string;
  remove(id: string): void;
  rename(id: string, name: string): void;
  /** Inserts just before `beforeTrackId`, or at the end when null or not found. */
  insertTracks(id: string, tracks: ParsedTrack[], beforeTrackId: string | null): void;
  removeTrack(id: string, index: number): void;
  shuffle(id: string): void;
  /** Shares a playlist with the room, or takes it back. */
  setPublic(id: string, isPublic: boolean): void;
  /**
   * Pulls a linked playlist's content from Spotify again.
   *
   * A playlist Spotify says is gone is dropped. A client we cannot reach
   * leaves it exactly as it is and reports `unreachable`.
   */
  sync(id: string): void;
  /** Cuts the tie to Spotify, keeping the tracks. */
  unlink(id: string): void;
  /** How the last sync of each linked playlist ended, by playlist id. */
  syncStateOf(id: string): SyncState;
}

/**
 * Holds this install's playlists. State starts from localStorage and every
 * mutation writes straight back, so the pure ops in lib/playlists stay the only
 * place that knows how a playlist changes.
 *
 * Syncing a linked playlist is the one thing here that reaches outside, so the
 * importer arrives as an argument rather than being reached for directly.
 */
export function usePlaylists(importer?: PlaylistImporter): PlaylistsApi {
  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  // One fetch per playlist at a time. Two syncs of the same playlist racing
  // would reconcile twice for no gain, and an open-triggered sync fires on
  // every selection.
  const inFlight = useRef<Set<string>>(new Set());

  const apply = useCallback((update: (lists: Playlist[]) => Playlist[]) => {
    setPlaylists((lists) => {
      const next = update(lists);
      if (next !== lists) savePlaylists(next);
      return next;
    });
  }, []);

  const setSyncState = useCallback((id: string, state: SyncState) => {
    setSyncStates((states) => (states[id] === state ? states : { ...states, [id]: state }));
  }, []);

  const sync = useCallback(
    (id: string) => {
      if (!importer) return;
      if (inFlight.current.has(id)) return;

      // Read the link off current state rather than trusting a caller's copy:
      // the playlist may have been unlinked since the call was wired up.
      let playlistId: string | null = null;
      setPlaylists((lists) => {
        playlistId = linkedPlaylistId(lists.find((l) => l.id === id) ?? ({} as Playlist)) ?? null;
        return lists;
      });
      if (!playlistId) return;

      inFlight.current.add(id);
      setSyncState(id, "syncing");

      void importer.import(`spotify:playlist:${playlistId}`).then(
        (imported) => {
          inFlight.current.delete(id);
          setSyncState(id, "idle");
          apply((l) => reconcileLinked(l, id, imported, Date.now()));
        },
        (error: unknown) => {
          inFlight.current.delete(id);
          // Spotify answered that the playlist is gone: the content is really
          // gone, so the linked playlist goes with it. Anything else means we
          // never got an answer, and the playlist must be left alone.
          if (isGone(error)) {
            setSyncState(id, "idle");
            apply((l) => deletePlaylist(l, id));
          } else {
            setSyncState(id, "unreachable");
          }
        },
      );
    },
    [importer, apply, setSyncState],
  );

  return {
    playlists,
    create: useCallback((name: string) => apply((l) => createPlaylist(l, name)), [apply]),
    createWithTracks: useCallback(
      (name: string, tracks: ParsedTrack[], source?: PlaylistSource) => {
        // The id is minted here, not inside the updater, so the caller can
        // select the new playlist without waiting for state to land.
        const id = crypto.randomUUID();
        apply((l) => createPlaylistWithTracks(l, name, tracks, id, source));
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
    sync,
    unlink: useCallback((id: string) => apply((l) => unlinkPlaylist(l, id)), [apply]),
    syncStateOf: useCallback((id: string) => syncStates[id] ?? "idle", [syncStates]),
  };
}
