/** Narrowing a playlist menu by name. Pure, so the menu stays a view. */

export const FILTER_THRESHOLD = 5;

/** True when the list is long enough to warrant a filter field. */
export function shouldShowFilter(count: number): boolean {
  return count > FILTER_THRESHOLD;
}

export function filterPlaylists<T extends { name: string }>(
  playlists: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...playlists];
  return playlists.filter((playlist) => playlist.name.toLowerCase().includes(needle));
}
