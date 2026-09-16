import type { PlaylistTrack, SharedPlaylist } from "@spotjam/protocol";
import { shuffled } from "./shuffle";

/**
 * One track's place in one playlist.
 *
 * A `PlaylistTrack` says *which track, and how long*. A row says *this
 * occurrence of it, here* — which is what Spotify's playlist service removes
 * and reorders, and why it gives each row a `uid` of its own rather than
 * keying on the track.
 *
 * The length rides along because a playlist is a place tracks are queued from,
 * and a queue item must carry one. Carrying it here means the lookup happens
 * once, where the track entered — a fetch, or a pasted link — rather than
 * again on every enqueue.
 *
 * The uid belongs to Spotify's copy, so a local playlist's rows have none, and
 * `toSharedPlaylists` never puts it on the wire.
 */
export interface PlaylistRow {
  track: PlaylistTrack;
  /** Spotify's identity for this row. Absent for a local playlist. */
  uid?: string;
}

/**
 * Where a playlist's content comes from.
 *
 * A local playlist is yours: you add, remove and reorder its tracks. A linked
 * one mirrors a Spotify playlist — Spotify owns the content, so edits are
 * written there and come back on the next sync.
 *
 * This is install-local state. `toSharedPlaylists` projects it away, so a peer
 * sees a linked playlist as an ordinary one.
 */
export type PlaylistSource =
  | { kind: "local" }
  | {
      kind: "spotify";
      playlistId: string;
      syncedAt: number;
      /**
       * Whether Spotify lets us add tracks to it. A link can point at anyone's
       * playlist, and only its owner may write.
       */
      canAdd: boolean;
      /**
       * Whether Spotify lets us remove and reorder its rows. Separate from
       * `canAdd`: a playlist can allow one and refuse the other.
       */
      canEditItems: boolean;
    };

export interface Playlist {
  id: string;
  name: string;
  rows: PlaylistRow[];
  /** Public playlists are visible to everyone else in the room. */
  isPublic: boolean;
  source: PlaylistSource;
}

const LOCAL: PlaylistSource = { kind: "local" };

/** The track references a playlist holds, in order. */
export function tracksOf(playlist: Playlist): PlaylistTrack[] {
  return playlist.rows.map((row) => row.track);
}

/** Wraps bare tracks as rows with no Spotify identity. */
export function rowsOfTracks(tracks: PlaylistTrack[]): PlaylistRow[] {
  return tracks.map((track) => ({ track }));
}

/**
 * Whether a playlist's name may be changed here.
 *
 * False for a linked playlist: Spotify owns the name, and a rename would only
 * survive until the next sync.
 */
export function isEditable(playlist: Playlist): boolean {
  return playlist.source.kind === "local";
}

/** The Spotify playlist id a linked playlist mirrors, or null when local. */
export function linkedPlaylistId(playlist: Playlist): string | null {
  return playlist.source.kind === "spotify" ? playlist.source.playlistId : null;
}

/**
 * Whether tracks can be added to this playlist at all.
 *
 * A local playlist always takes them. A linked one takes them only when
 * Spotify lets us write, because that is where they would have to land.
 */
export function canAddTracks(playlist: Playlist): boolean {
  return playlist.source.kind === "local" ? true : playlist.source.canAdd;
}

/**
 * Whether rows can be removed or reordered.
 *
 * Spotify tracks this separately from adding, so a playlist may take new
 * tracks while refusing to let its existing ones be moved.
 */
export function canEditItems(playlist: Playlist): boolean {
  return playlist.source.kind === "local" ? true : playlist.source.canEditItems;
}

/**
 * Pure operations over a user's playlist collection. Every function returns a
 * new array and leaves its input untouched, so React state updates stay honest.
 */

export function createPlaylist(lists: Playlist[], name: string, id?: string): Playlist[] {
  const trimmed = name.trim();
  return [
    ...lists,
    {
      id: id ?? crypto.randomUUID(),
      name: trimmed || "Untitled",
      rows: [],
      isPublic: false,
      source: LOCAL,
    },
  ];
}

/**
 * Creates a playlist that already holds tracks — one step, so an import lands
 * in a single save. A name that already exists is kept as-is; duplicate names
 * are allowed because ids, not names, identify a playlist. A track listed
 * twice lands once, at its first position.
 */
export function createPlaylistWithTracks(
  lists: Playlist[],
  name: string,
  rows: PlaylistRow[],
  id?: string,
  source: PlaylistSource = LOCAL,
): Playlist[] {
  const created = createPlaylist(lists, name, id);
  const fresh = created[created.length - 1];
  return [...created.slice(0, -1), { ...fresh, rows: dedupedRows(rows), source }];
}

/**
 * Replaces a linked playlist's name and rows with what Spotify just handed
 * back, and stamps the sync time.
 *
 * Wholesale replacement is the point: Spotify owns the content, so a track
 * dropped there is dropped here, the order is theirs, and the row uids come
 * back fresh — which is what keeps a later remove or move addressing rows that
 * still exist. Local playlists and unknown ids are left alone, which is what
 * makes a stale sync landing after an unlink harmless.
 */
export function reconcileLinked(
  lists: Playlist[],
  id: string,
  fetched: { name: string; rows: PlaylistRow[]; canAdd?: boolean; canEditItems?: boolean },
  syncedAt: number,
): Playlist[] {
  return mapList(lists, id, (list) => {
    if (list.source.kind !== "spotify") return list;
    const name = fetched.name.trim() || list.name;
    return {
      ...list,
      name,
      rows: dedupedRows(fetched.rows),
      source: {
        ...list.source,
        syncedAt,
        // Permission can change under us — a collaborative playlist opened up,
        // or access withdrawn — so each sync restates it.
        canAdd: fetched.canAdd ?? false,
        canEditItems: fetched.canEditItems ?? false,
      },
    };
  });
}

/**
 * Cuts a playlist's tie to Spotify, keeping the tracks it holds right now.
 *
 * The row uids go with the link: they name rows in Spotify's copy, and this
 * playlist no longer mirrors it.
 */
export function unlinkPlaylist(lists: Playlist[], id: string): Playlist[] {
  return mapList(lists, id, (list) =>
    list.source.kind === "local"
      ? list
      : { ...list, source: LOCAL, rows: list.rows.map((row) => ({ track: row.track })) },
  );
}

/** The name a new playlist gets: "Untitled", then "Untitled 2", "Untitled 3", ... */
export function defaultPlaylistName(existing: string[]): string {
  if (!existing.includes("Untitled")) return "Untitled";
  for (let n = 2; ; n += 1) {
    const candidate = `Untitled ${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export function deletePlaylist(lists: Playlist[], id: string): Playlist[] {
  return lists.filter((list) => list.id !== id);
}

export function renamePlaylist(lists: Playlist[], id: string, name: string): Playlist[] {
  const trimmed = name.trim();
  if (!trimmed) return lists;
  return mapList(lists, id, (list) => ({ ...list, name: trimmed }));
}

/**
 * Insert tracks just before `beforeTrackId`, or at the end when it is `null`
 * or not found. A playlist holds each `trackId` once, so a dropped track that
 * duplicates one already there is skipped rather than moved.
 */
export function insertTracksIntoPlaylist(
  lists: Playlist[],
  id: string,
  tracks: PlaylistTrack[],
  beforeTrackId: string | null,
): Playlist[] {
  if (tracks.length === 0) return lists;
  return mapList(lists, id, (list) => {
    const seen = new Set(list.rows.map((row) => row.track.trackId));
    const fresh: PlaylistRow[] = [];
    for (const track of tracks) {
      if (seen.has(track.trackId)) continue;
      seen.add(track.trackId);
      fresh.push({ track });
    }
    if (fresh.length === 0) return list;

    const insertAt = list.rows.findIndex((row) => row.track.trackId === beforeTrackId);
    const targetIndex = insertAt < 0 ? list.rows.length : insertAt;
    const nextRows = [...list.rows];
    nextRows.splice(targetIndex, 0, ...fresh);
    return { ...list, rows: nextRows };
  });
}

/**
 * Moves one row to sit before `beforeTrackId`, or to the end when it is null.
 *
 * Reordering is by track id rather than index because that is what the drop
 * target knows, and a row's index shifts as soon as it is lifted out.
 */
export function moveRowInPlaylist(
  lists: Playlist[],
  id: string,
  trackId: string,
  beforeTrackId: string | null,
): Playlist[] {
  if (trackId === beforeTrackId) return lists;
  return mapList(lists, id, (list) => {
    const from = list.rows.findIndex((row) => row.track.trackId === trackId);
    if (from < 0) return list;

    const without = list.rows.filter((_, at) => at !== from);
    const before = without.findIndex((row) => row.track.trackId === beforeTrackId);
    const targetIndex = before < 0 ? without.length : before;
    if (targetIndex === from) return list;

    const nextRows = [...without];
    nextRows.splice(targetIndex, 0, list.rows[from]);
    return { ...list, rows: nextRows };
  });
}

/** Randomizes a playlist's stored order. Fewer than two rows is a no-op. */
export function shufflePlaylist(lists: Playlist[], id: string): Playlist[] {
  return mapList(lists, id, (list) =>
    list.rows.length < 2 ? list : { ...list, rows: shuffled(list.rows) },
  );
}

export function removeTrackFromPlaylist(lists: Playlist[], id: string, index: number): Playlist[] {
  return mapList(lists, id, (list) => {
    if (index < 0 || index >= list.rows.length) return list;
    return { ...list, rows: list.rows.filter((_, at) => at !== index) };
  });
}

/** Publish a playlist to the room, or take it back. */
export function setPlaylistPublic(lists: Playlist[], id: string, isPublic: boolean): Playlist[] {
  return mapList(lists, id, (list) => (list.isPublic === isPublic ? list : { ...list, isPublic }));
}

/**
 * The public playlists, in the wire shape the room server holds.
 *
 * Private ones never leave this install, so they are dropped here rather than
 * filtered somewhere downstream. Row uids stay behind too: they name rows in
 * Spotify's copy and mean nothing to a peer.
 */
export function toSharedPlaylists(lists: Playlist[]): SharedPlaylist[] {
  return lists
    .filter((list) => list.isPublic)
    .map((list) => ({
      id: list.id,
      name: list.name,
      tracks: list.rows.map((row) => ({
        uri: row.track.uri,
        trackId: row.track.trackId,
        durationMs: row.track.durationMs,
      })),
    }));
}

/** Keeps the first row for each track id, in the order given. */
function dedupedRows(rows: PlaylistRow[]): PlaylistRow[] {
  const seen = new Set<string>();
  const out: PlaylistRow[] = [];
  for (const row of rows) {
    if (seen.has(row.track.trackId)) continue;
    seen.add(row.track.trackId);
    out.push(row);
  }
  return out;
}

function mapList(
  lists: Playlist[],
  id: string,
  update: (list: Playlist) => Playlist,
): Playlist[] {
  return lists.map((list) => (list.id === id ? update(list) : list));
}
