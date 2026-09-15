import type { TrackInfo } from "../ports/track-metadata";

/** True if any whitespace-separated token of `query` appears as a substring of `text`. */
export function tokenMatch(query: string, text: string): boolean {
  const t = text.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.some((token) => t.includes(token));
}

/** Matches a track's title and artist; falls back to the track id when metadata hasn't loaded. */
export function matchesTrack(
  query: string,
  metadata: TrackInfo | undefined,
  trackId: string,
): boolean {
  if (query.trim() === "") return true;
  const haystack = metadata ? `${metadata.title} ${metadata.artist}` : trackId;
  return tokenMatch(query, haystack);
}
