/** Anything that names a Spotify track. Queue items and playlist tracks both do. */
export interface HasTrackId {
  trackId: string;
}

/** Anything with a queue-scoped identity: a queue item, not the track itself. */
export interface HasId {
  id: string;
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

/**
 * Move the entries named by `movedIds` out of `queue` as one block, and
 * reinsert them, in their existing relative order, just before
 * `beforeId` — or at the end when `beforeId` is `null` or not found among
 * the entries left behind.
 *
 * `movedIds` is trusted only as a set of which entries move: their order in
 * the queue survives the move, not whatever order the caller listed them in.
 * A `beforeId` that names one of the moved entries is nonsensical (the block
 * can't be inserted before part of itself) and is treated as "not found".
 * Returns `queue` itself when nothing would change.
 */
export function moveMany<T extends HasId>(
  queue: readonly T[],
  movedIds: readonly string[],
  beforeId: string | null,
): readonly T[] {
  const movedSet = new Set(movedIds);
  if (movedSet.size === 0) return queue;
  if (beforeId !== null && movedSet.has(beforeId)) beforeId = null;

  const moved = queue.filter((entry) => movedSet.has(entry.id));
  if (moved.length === 0) return queue;
  const rest = queue.filter((entry) => !movedSet.has(entry.id));

  const insertAt = beforeId === null ? rest.length : rest.findIndex((entry) => entry.id === beforeId);
  const targetIndex = insertAt < 0 ? rest.length : insertAt;

  const next = [...rest];
  next.splice(targetIndex, 0, ...moved);
  return sameOrder(queue, next) ? queue : next;
}

function sameOrder<T extends HasId>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.id === b[i]?.id);
}
