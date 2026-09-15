import type { PlaylistTrack, QueueItem } from "@spotjam/protocol";

export interface Selection {
  ids: ReadonlySet<string>;
  anchorId: string | null;
}

export const emptySelection: Selection = { ids: new Set(), anchorId: null };

export interface ClickModifiers {
  shift: boolean;
  /** ctrl or meta. */
  toggle: boolean;
}

/**
 * Shift-click extends a range from the anchor, leaving the anchor where it is;
 * ctrl/cmd-click toggles one row in or out and moves the anchor there (so a drag
 * can carry a non-contiguous set); plain click replaces the selection with just
 * the clicked row, or clears it when that row was the only one selected.
 */
export function applySelectionClick(
  sel: Selection,
  orderedIds: readonly string[],
  clickedId: string,
  mods: ClickModifiers,
): Selection {
  const index = orderedIds.indexOf(clickedId);

  if (mods.shift && sel.anchorId !== null) {
    const anchorIndex = orderedIds.indexOf(sel.anchorId);
    const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    return { ids: new Set(orderedIds.slice(start, end + 1)), anchorId: sel.anchorId };
  }

  if (mods.toggle) {
    const ids = new Set(sel.ids);
    if (ids.has(clickedId)) ids.delete(clickedId);
    else ids.add(clickedId);
    return { ids, anchorId: clickedId };
  }

  const sole = sel.ids.size === 1 && sel.ids.has(clickedId);
  return { ids: sole ? new Set() : new Set([clickedId]), anchorId: clickedId };
}

/**
 * A right-click inside the selection acts on the whole selection and leaves it
 * alone; one outside it selects just that row first, so the menu always names
 * what the user can see is highlighted.
 */
export function targetsForContextClick(
  sel: Selection,
  clickedId: string,
): { targetIds: string[]; selection: Selection } {
  if (sel.ids.has(clickedId)) return { targetIds: [...sel.ids], selection: sel };
  return {
    targetIds: [clickedId],
    selection: { ids: new Set([clickedId]), anchorId: clickedId },
  };
}

/** Drops ids that have left the list, so a stale selection cannot be dragged. */
export function pruneSelection(sel: Selection, liveIds: readonly string[]): Selection {
  const live = new Set(liveIds);
  const kept = [...sel.ids].filter((id) => live.has(id));
  const anchorId = sel.anchorId !== null && live.has(sel.anchorId) ? sel.anchorId : null;
  if (kept.length === sel.ids.size && anchorId === sel.anchorId) return sel;
  return { ids: new Set(kept), anchorId };
}

/** Queue rows carry a queue identity the playlist ops have no use for. */
export function toPlaylistTracks(items: readonly QueueItem[]): PlaylistTrack[] {
  return items.map((item) => ({ uri: item.uri, trackId: item.trackId }));
}

/** The named rows, as playlist tracks, in the list's own order. */
export function tracksOf(items: readonly QueueItem[], ids: readonly string[]): PlaylistTrack[] {
  const wanted = new Set(ids);
  return toPlaylistTracks(items.filter((item) => wanted.has(item.id)));
}
