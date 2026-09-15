/** Anything that names a Spotify track. Queue items and playlist tracks both do. */
export interface HasTrackId {
  trackId: string;
}

/**
 * Append `incoming` to `existing`, keeping one entry per track.
 *
 * The entry already in place wins: a track that `existing` holds is skipped,
 * and a track that appears twice in `incoming` lands once, at its first
 * position. Returns `existing` itself when nothing new arrives, so callers
 * can keep referential equality for a no-op.
 */
export function appendUniqueTracks<T extends HasTrackId>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const seen = new Set(existing.map((entry) => entry.trackId));
  const fresh: T[] = [];
  for (const entry of incoming) {
    if (seen.has(entry.trackId)) continue;
    seen.add(entry.trackId);
    fresh.push(entry);
  }
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}
