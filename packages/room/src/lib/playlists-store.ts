import type { Playlist } from "./playlists";

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
    return parsed.filter(isPlaylist);
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
