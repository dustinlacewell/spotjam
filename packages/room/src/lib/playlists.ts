import type { ParsedTrack } from "./spotify-link";
import { shuffled } from "./shuffle";

export interface Playlist {
  id: string;
  name: string;
  tracks: ParsedTrack[];
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
    },
  ];
}

/**
 * Creates a playlist that already holds tracks — one step, so an import lands
 * in a single save. A name that already exists is kept as-is; duplicate names
 * are allowed because ids, not names, identify a playlist.
 */
export function createPlaylistWithTracks(
  lists: Playlist[],
  name: string,
  tracks: ParsedTrack[],
  id?: string,
): Playlist[] {
  const created = createPlaylist(lists, name, id);
  const fresh = created[created.length - 1];
  return [...created.slice(0, -1), { ...fresh, tracks: [...tracks] }];
}

export function deletePlaylist(lists: Playlist[], id: string): Playlist[] {
  return lists.filter((list) => list.id !== id);
}

export function renamePlaylist(lists: Playlist[], id: string, name: string): Playlist[] {
  const trimmed = name.trim();
  if (!trimmed) return lists;
  return mapList(lists, id, (list) => ({ ...list, name: trimmed }));
}

export function addTracksToPlaylist(
  lists: Playlist[],
  id: string,
  tracks: ParsedTrack[],
): Playlist[] {
  if (tracks.length === 0) return lists;
  return mapList(lists, id, (list) => ({ ...list, tracks: [...list.tracks, ...tracks] }));
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

function mapList(
  lists: Playlist[],
  id: string,
  update: (list: Playlist) => Playlist,
): Playlist[] {
  return lists.map((list) => (list.id === id ? update(list) : list));
}
