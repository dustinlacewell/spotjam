import type { Playlist, PlaylistSource } from "./playlists";

const STORAGE_KEY = "spotjam.playlists";

/**
 * Playlists live on this install only, in localStorage. Reads and writes are
 * best-effort: a blocked or corrupt store degrades to an empty collection
 * rather than breaking the app.
 */
export function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlaylist).map(withPublicFlag).map(withSource);
  } catch {
    return [];
  }
}

export function savePlaylists(lists: Playlist[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lists));
  } catch {
    // Storage unavailable (private mode, quota). Persisting is best-effort.
  }
}

function isPlaylist(value: unknown): value is Playlist {
  const list = value as Partial<Playlist> | null;
  return (
    typeof list?.id === "string" &&
    typeof list.name === "string" &&
    Array.isArray(list.tracks)
  );
}

/**
 * Playlists stored before sharing existed carry no flag. They load private:
 * nothing goes to the room until its owner says so.
 */
function withPublicFlag(list: Playlist): Playlist {
  return list.isPublic === true ? list : { ...list, isPublic: false };
}

/**
 * Playlists stored before linking existed carry no source. They load local,
 * which is what they are: spotjam owns their content.
 *
 * A stored source is only honoured when it is a well-formed link. Anything
 * else — a half-written object, a hand-edited store — degrades to local rather
 * than producing a playlist that claims to mirror a playlist id it does not
 * have, which would then be syncable and auto-droppable.
 */
function withSource(list: Playlist): Playlist {
  return isLinkedSource(list.source) ? list : { ...list, source: { kind: "local" } };
}

function isLinkedSource(source: PlaylistSource | undefined): boolean {
  if (source?.kind !== "spotify") return false;
  return typeof source.playlistId === "string" && source.playlistId.length > 0;
}
