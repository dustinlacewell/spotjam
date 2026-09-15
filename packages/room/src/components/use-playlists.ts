import { useCallback, useRef, useState } from "react";
import type { ParsedTrack } from "../lib/spotify-link";
import {
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  linkedPlaylistId,
  moveRowInPlaylist,
  reconcileLinked,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  unlinkPlaylist,
  type Playlist,
  type PlaylistRow,
  type PlaylistSource,
} from "../lib/playlists";
import { loadPlaylists, savePlaylists } from "../lib/playlists-store";
import { isGone, type PlaylistService } from "../ports/playlist-service";

/** How a linked playlist's last sync attempt ended. */
export type SyncState = "idle" | "syncing" | "unreachable";

export interface PlaylistsApi {
  playlists: Playlist[];
  create(name: string): void;
  /** Creates a playlist already holding rows, and returns its new id. */
  createWithTracks(name: string, rows: PlaylistRow[], source?: PlaylistSource): string;
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
  /**
   * Appends tracks to a playlist, wherever that playlist's content lives.
   *
   * A local playlist takes them directly. A linked one is owned by Spotify, so
   * the tracks are written there and the playlist syncs to pick them up —
   * otherwise the next sync would throw them away.
   */
  addTracks(id: string, tracks: ParsedTrack[]): void;
  /**
   * Moves one row to sit before `beforeTrackId`, or to the end when null.
   *
   * A linked playlist's order lives in Spotify, so the move is written there
   * and the playlist syncs. A local one reorders in place.
   */
  moveRow(id: string, trackId: string, beforeTrackId: string | null): void;
}

/**
 * Holds this install's playlists. State starts from localStorage and every
 * mutation writes straight back, so the pure ops in lib/playlists stay the only
 * place that knows how a playlist changes.
 *
 * Syncing a linked playlist is the one thing here that reaches outside, so the
 * importer arrives as an argument rather than being reached for directly.
 */
export function usePlaylists(service?: PlaylistService): PlaylistsApi {
  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({});
  // One fetch per playlist at a time. Two syncs of the same playlist racing
  // would reconcile twice for no gain, and an open-triggered sync fires on
  // every selection.
  const inFlight = useRef<Set<string>>(new Set());

  // What the writes below read to find a playlist.
  //
  // It has to be a ref, not the state variable: a callback that closed over
  // `playlists` would change identity on every edit, and `sync` is a
  // dependency of the effect that syncs a playlist on open — so each sync
  // would re-arm that effect and sync again, forever.
  const playlistsRef = useRef(playlists);
  playlistsRef.current = playlists;

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
      if (!service) return;
      if (inFlight.current.has(id)) return;

      // Read the link off current state rather than trusting a caller's copy:
      // the playlist may have been unlinked since the call was wired up.
      const playlist = playlistsRef.current.find((l) => l.id === id);
      const playlistId = playlist ? linkedPlaylistId(playlist) : null;
      if (!playlistId) return;

      inFlight.current.add(id);
      setSyncState(id, "syncing");

      void service.import(`spotify:playlist:${playlistId}`).then(
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
    [service, apply, setSyncState],
  );

  /**
   * The playlist as state holds it right now.
   *
   * Every write has to consult this rather than a caller's copy: a linked
   * playlist may have been unlinked, and its rows resynced, since the handler
   * was wired up.
   */
  const currentPlaylist = useCallback(
    (id: string): Playlist | null => playlistsRef.current.find((l) => l.id === id) ?? null,
    [],
  );

  const addTracks = useCallback(
    (id: string, tracks: ParsedTrack[]) => {
      if (tracks.length === 0) return;

      const playlist = currentPlaylist(id);
      if (!playlist) return;
      const playlistId = linkedPlaylistId(playlist);

      if (playlistId === null) {
        apply((l) => insertTracksIntoPlaylist(l, id, tracks, null));
        return;
      }
      if (!service) return;

      // The write lands in Spotify; the sync brings it back. Syncing rather
      // than inserting locally keeps Spotify's order and row uids authoritative.
      void service.addTracks(playlistId, tracks).then(
        () => sync(id),
        () => setSyncState(id, "unreachable"),
      );
    },
    [service, apply, sync, setSyncState, currentPlaylist],
  );

  const removeTrack = useCallback(
    (id: string, index: number) => {
      const playlist = currentPlaylist(id);
      if (!playlist) return;
      const playlistId = linkedPlaylistId(playlist);

      if (playlistId === null) {
        apply((l) => removeTrackFromPlaylist(l, id, index));
        return;
      }
      const row = playlist.rows[index];
      if (!row || !service) return;

      void service.removeRows(playlistId, [row]).then(
        () => sync(id),
        () => setSyncState(id, "unreachable"),
      );
    },
    [service, apply, sync, setSyncState, currentPlaylist],
  );

  const moveRow = useCallback(
    (id: string, trackId: string, beforeTrackId: string | null) => {
      if (trackId === beforeTrackId) return;

      const playlist = currentPlaylist(id);
      if (!playlist) return;
      const playlistId = linkedPlaylistId(playlist);

      if (playlistId === null) {
        apply((l) => moveRowInPlaylist(l, id, trackId, beforeTrackId));
        return;
      }
      if (!service) return;

      const row = playlist.rows.find((r) => r.track.trackId === trackId);
      if (!row) return;

      // Spotify has no "end" spec for a move — `{before:{type:"end"}}` sends
      // the row to the front instead — so landing last means naming the row
      // currently there, which cannot be the one being moved.
      const target = targetFor(playlist.rows, row, beforeTrackId);
      if (!target) return;

      void service.moveRow(playlistId, row, target).then(
        () => sync(id),
        () => setSyncState(id, "unreachable"),
      );
    },
    [service, apply, sync, setSyncState, currentPlaylist],
  );

  return {
    playlists,
    create: useCallback((name: string) => apply((l) => createPlaylist(l, name)), [apply]),
    createWithTracks: useCallback(
      (name: string, rows: PlaylistRow[], source?: PlaylistSource) => {
        // The id is minted here, not inside the updater, so the caller can
        // select the new playlist without waiting for state to land.
        const id = crypto.randomUUID();
        apply((l) => createPlaylistWithTracks(l, name, rows, id, source));
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
    removeTrack,
    shuffle: useCallback((id: string) => apply((l) => shufflePlaylist(l, id)), [apply]),
    setPublic: useCallback(
      (id: string, isPublic: boolean) => apply((l) => setPlaylistPublic(l, id, isPublic)),
      [apply],
    ),
    sync,
    unlink: useCallback((id: string) => apply((l) => unlinkPlaylist(l, id)), [apply]),
    syncStateOf: useCallback((id: string) => syncStates[id] ?? "idle", [syncStates]),
    addTracks,
    moveRow,
  };
}

/**
 * Which row a moved row should land against.
 *
 * Dropping before a named track is expressed directly. Dropping at the end has
 * to name the row to sit after, and that row must not be the one moving — so a
 * row already last has nowhere to go.
 */
function targetFor(
  rows: PlaylistRow[],
  moving: PlaylistRow,
  beforeTrackId: string | null,
): { beforeUid: string } | { afterUid: string } | null {
  if (beforeTrackId !== null) {
    const before = rows.find((r) => r.track.trackId === beforeTrackId);
    return before?.uid ? { beforeUid: before.uid } : null;
  }
  const others = rows.filter((r) => r.track.trackId !== moving.track.trackId);
  const last = others[others.length - 1];
  return last?.uid ? { afterUid: last.uid } : null;
}
