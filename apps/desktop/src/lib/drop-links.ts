import { parseSpotifyLinks, type ParsedLinks, type ParsedTrack } from "./spotify-link";

/** The part of a DataTransfer this module needs. Keeps the logic testable without a DOM. */
export interface DropData {
  getData(type: string): string;
  types?: readonly string[];
}

/** Marks a drag that started inside spotjam (queue reordering), so drop zones can ignore it. */
export const INTERNAL_DRAG_MIME = "application/x-spotjam-item";

/**
 * Reads the Spotify tracks out of a drop from the Spotify desktop app. Spotify
 * puts the share URLs in text/uri-list, text/plain, or both; we take the union
 * and dedupe. Drags that started inside spotjam yield nothing.
 */
export function tracksFromDrop(data: DropData): ParsedTrack[] {
  return linksFromDrop(data).tracks;
}

/**
 * Same payload handling as tracksFromDrop, but keeps the playlist links too, so
 * a drop can carry a mix of tracks and playlists.
 */
export function linksFromDrop(data: DropData): ParsedLinks {
  if (data.types?.includes(INTERNAL_DRAG_MIME)) return { tracks: [], playlists: [] };

  const uriList = readType(data, "text/uri-list");
  const plain = readType(data, "text/plain");
  return parseSpotifyLinks(`${uriList}\n${plain}`);
}

function readType(data: DropData, type: string): string {
  try {
    return data.getData(type) ?? "";
  } catch {
    // Some browsers throw when a type is absent during dragover.
    return "";
  }
}
