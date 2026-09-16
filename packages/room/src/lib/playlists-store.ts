import type { PlaylistTrack } from "@spotjam/protocol";
import type { Playlist, PlaylistRow, PlaylistSource } from "./playlists";

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
    return parsed.filter(isStoredPlaylist).map(toPlaylist);
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

/** What a stored playlist may look like, across every version we have written. */
interface StoredPlaylist {
  id: string;
  name: string;
  /** Written since rows existed. */
  rows?: unknown;
  /** Written before rows existed: bare track references. */
  tracks?: unknown;
  isPublic?: unknown;
  source?: PlaylistSource;
}

function isStoredPlaylist(value: unknown): value is StoredPlaylist {
  const list = value as Partial<StoredPlaylist> | null;
  return (
    typeof list?.id === "string" &&
    typeof list.name === "string" &&
    (Array.isArray(list.rows) || Array.isArray(list.tracks))
  );
}

function toPlaylist(stored: StoredPlaylist): Playlist {
  return {
    id: stored.id,
    name: stored.name,
    rows: storedRows(stored),
    // Playlists stored before sharing existed carry no flag. They load
    // private: nothing goes to the room until its owner says so.
    isPublic: stored.isPublic === true,
    source: storedSource(stored.source),
  };
}

/**
 * Rows, from either shape.
 *
 * Playlists stored before rows existed hold bare tracks, which become rows
 * with no Spotify identity — correct, because a uid only ever came from a
 * sync, and the next one restores it.
 *
 * A track stored before lengths were kept loads with `durationMs` 0. That is
 * honest — the length is genuinely unknown — and the enqueue path treats a
 * zero as "no length" and looks it up rather than sending it.
 */
function storedRows(stored: StoredPlaylist): PlaylistRow[] {
  if (Array.isArray(stored.rows)) {
    return stored.rows.filter(isRow).map((row) => ({
      track: toTrack(row.track),
      ...(typeof row.uid === "string" && row.uid.length > 0 ? { uid: row.uid } : {}),
    }));
  }
  const tracks = Array.isArray(stored.tracks) ? stored.tracks : [];
  return tracks.filter(isTrack).map((track) => ({ track: toTrack(track) }));
}

function toTrack(stored: { uri: string; trackId: string; durationMs?: unknown }): PlaylistTrack {
  return {
    uri: stored.uri,
    trackId: stored.trackId,
    durationMs: typeof stored.durationMs === "number" && stored.durationMs > 0 ? stored.durationMs : 0,
  };
}

function isRow(
  value: unknown,
): value is { track: { uri: string; trackId: string; durationMs?: unknown }; uid?: string } {
  const row = value as { track?: { uri?: unknown; trackId?: unknown } } | null;
  return typeof row?.track?.uri === "string" && typeof row.track.trackId === "string";
}

function isTrack(value: unknown): value is { uri: string; trackId: string; durationMs?: unknown } {
  const track = value as { uri?: unknown; trackId?: unknown } | null;
  return typeof track?.uri === "string" && typeof track.trackId === "string";
}

/**
 * A stored source is only honoured when it is a well-formed link. Anything
 * else — a half-written object, a hand-edited store — degrades to local rather
 * than producing a playlist that claims to mirror a playlist id it does not
 * have, which would then be syncable and auto-droppable.
 *
 * A link stored before a permission was tracked loads without it: offering a
 * write Spotify will refuse is the worse mistake, and the next sync restates
 * both flags anyway.
 */
function storedSource(source: PlaylistSource | undefined): PlaylistSource {
  if (source?.kind !== "spotify") return { kind: "local" };
  if (typeof source.playlistId !== "string" || source.playlistId.length === 0) {
    return { kind: "local" };
  }
  return {
    kind: "spotify",
    playlistId: source.playlistId,
    syncedAt: typeof source.syncedAt === "number" ? source.syncedAt : 0,
    canAdd: source.canAdd === true,
    canEditItems: source.canEditItems === true,
  };
}
