import { appendUniqueTracks, type SharedPlaylist } from "@spotjam/protocol";
import type { ParsedTrack } from "./spotify-link";
import { shuffled } from "./shuffle";

export interface Playlist {
  id: string;
  name: string;
  tracks: ParsedTrack[];
  /** Public playlists are visible to everyone else in the room. */
  isPublic: boolean;
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
      tracks: [],
      isPublic: false,
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
  tracks: ParsedTrack[],
  id?: string,
): Playlist[] {
  const created = createPlaylist(lists, name, id);
  const fresh = created[created.length - 1];
  return [...created.slice(0, -1), { ...fresh, tracks: [...appendUniqueTracks([], tracks)] }];
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
 * or not found. A track holds each `trackId` once, so a dropped track that
 * duplicates one already in the playlist is skipped rather than moved.
 */
export function insertTracksIntoPlaylist(
  lists: Playlist[],
  id: string,
  tracks: ParsedTrack[],
  beforeTrackId: string | null,
): Playlist[] {
  if (tracks.length === 0) return lists;
  return mapList(lists, id, (list) => {
    const seen = new Set(list.tracks.map((track) => track.trackId));
    const fresh: ParsedTrack[] = [];
    for (const track of tracks) {
      if (seen.has(track.trackId)) continue;
      seen.add(track.trackId);
      fresh.push(track);
    }
    if (fresh.length === 0) return list;

    const insertAt = list.tracks.findIndex((track) => track.trackId === beforeTrackId);
    const targetIndex = insertAt < 0 ? list.tracks.length : insertAt;
    const nextTracks = [...list.tracks];
    nextTracks.splice(targetIndex, 0, ...fresh);
    return { ...list, tracks: nextTracks };
  });
}

/** Randomizes a playlist's stored order. Fewer than two tracks is a no-op. */
export function shufflePlaylist(lists: Playlist[], id: string): Playlist[] {
  return mapList(lists, id, (list) =>
    list.tracks.length < 2 ? list : { ...list, tracks: shuffled(list.tracks) },
  );
}

export function removeTrackFromPlaylist(lists: Playlist[], id: string, index: number): Playlist[] {
  return mapList(lists, id, (list) => {
    if (index < 0 || index >= list.tracks.length) return list;
    return { ...list, tracks: list.tracks.filter((_, at) => at !== index) };
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
 * filtered somewhere downstream.
 */
export function toSharedPlaylists(lists: Playlist[]): SharedPlaylist[] {
  return lists
    .filter((list) => list.isPublic)
    .map((list) => ({
      id: list.id,
      name: list.name,
      tracks: list.tracks.map((track) => ({ uri: track.uri, trackId: track.trackId })),
    }));
}

function mapList(
  lists: Playlist[],
  id: string,
  update: (list: Playlist) => Playlist,
): Playlist[] {
  return lists.map((list) => (list.id === id ? update(list) : list));
}
