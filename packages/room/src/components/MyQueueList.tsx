import { Fragment, useState } from "react";
import { moveMany, type QueueItem } from "@spotjam/protocol";
import { INTERNAL_DRAG_MIME } from "../lib/drop-links";
import { matchesTrack } from "../lib/track-search";
import { QueueItemCard } from "./QueueItemCard";
import { useTrackMetadataMap } from "./use-track-metadata";
import styles from "./QueueLists.module.css";

export function MyQueueList({
  items,
  query,
  onMoveMany,
  onSendToTop,
  onRemove,
}: {
  items: QueueItem[];
  /** Filters the visible list; reordering stays disabled while it's non-empty. */
  query: string;
  /** Moves `itemIds` as one block to just before `beforeItemId`, or the end when null. */
  onMoveMany: (itemIds: string[], beforeItemId: string | null) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
}) {
  // Shift-click extends a range from this row; ctrl/cmd-click toggles this
  // row in or out of the selection, leaving the rest as-is (so a drag can
  // carry a non-contiguous set); plain click replaces the selection with
  // just the clicked row (or clears it, clicking the only selected row).
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [draggedIds, setDraggedIds] = useState<ReadonlySet<string> | null>(null);
  // Position between rows (0..visibleItems.length), not a row itself — so
  // the last gap (drop at the end) is a real, distinct target.
  const [overGap, setOverGap] = useState<number | null>(null);
  const metadataByUri = useTrackMetadataMap(items.map((item) => item.uri));

  if (items.length === 0) {
    return <p className={styles.empty}>Your queue is empty. Paste a link below.</p>;
  }

  const filtering = query.trim() !== "";
  const visibleItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => matchesTrack(query, metadataByUri.get(item.uri), item.trackId));

  if (visibleItems.length === 0) {
    return <p className={styles.empty}>No tracks match "{query}".</p>;
  }

  function handleRowClick(itemId: string, index: number, e: React.MouseEvent) {
    if (e.shiftKey && anchorId !== null) {
      const anchorIndex = items.findIndex((item) => item.id === anchorId);
      const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      setSelectedIds(new Set(items.slice(start, end + 1).map((item) => item.id)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchorId(itemId);
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(itemId)) next.delete(itemId);
        else next.add(itemId);
        return next;
      });
      return;
    }
    setAnchorId(itemId);
    setSelectedIds((current) => (current.size === 1 && current.has(itemId) ? new Set() : new Set([itemId])));
  }

  function handleDragStart(item: QueueItem, e: React.DragEvent) {
    const dragging = selectedIds.has(item.id) ? selectedIds : new Set([item.id]);
    setDraggedIds(dragging);
    e.dataTransfer.effectAllowed = "move";
    // Marks the drag as ours so track drop zones ignore it.
    e.dataTransfer.setData(INTERNAL_DRAG_MIME, item.id);
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData("text/plain", item.id);
  }

  function handleDragEnd() {
    setDraggedIds(null);
    setOverGap(null);
  }

  function handleDrop() {
    if (draggedIds !== null && overGap !== null) {
      onMoveMany([...draggedIds], resolveBeforeItemId(overGap, draggedIds));
    }
    handleDragEnd();
  }

  // A gap is a no-op drop when the block is already sitting right there —
  // reuse moveMany itself so this can't drift from what a real drop does.
  function isNoopGap(gap: number): boolean {
    if (draggedIds === null) return false;
    return moveMany(items, [...draggedIds], resolveBeforeItemId(gap, draggedIds)) === items;
  }

  /**
   * The item a gap should land the block before, skipping past any item
   * that is itself part of the drag.
   *
   * A non-contiguous selection leaves other selected rows sitting between
   * the gap and the nearest surviving neighbour — e.g. dropping between two
   * selected rows, or right before one. Naming that dragged row as the
   * target makes `moveMany` treat it as "not found" and dump the whole
   * block at the end. Walking forward to the next item that is *not* moving
   * gives the drop its real, stable destination instead.
   */
  function resolveBeforeItemId(gap: number, dragging: ReadonlySet<string>): string | null {
    for (let i = gap; i < items.length; i++) {
      const candidate = items[i];
      if (candidate !== undefined && !dragging.has(candidate.id)) return candidate.id;
    }
    return null;
  }

  return (
    <ul className={styles.list}>
      <DropIndicator active={overGap === 0} />
      {visibleItems.map(({ item, index }, position) => (
        <Fragment key={item.id}>
          <QueueItemCard
            item={item}
            isPlaying={false}
            // Your own queue: every track is yours, so no name chip.
            ownerLabel=""
            draggable={!filtering}
            isDragging={draggedIds?.has(item.id) ?? false}
            isSelected={selectedIds.has(item.id)}
            onClick={(e) => handleRowClick(item.id, index, e)}
            onDragStart={(e) => handleDragStart(item, e)}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const row = e.currentTarget.getBoundingClientRect();
              const isTopHalf = e.clientY < row.top + row.height / 2;
              const gap = isTopHalf ? position : position + 1;
              setOverGap(isNoopGap(gap) ? null : gap);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop();
            }}
            onDragEnd={handleDragEnd}
            onSendToTop={index === 0 ? undefined : () => onSendToTop(item.id)}
            onRemove={() => onRemove(item.id)}
          />
          <DropIndicator active={overGap === position + 1} />
        </Fragment>
      ))}
    </ul>
  );
}

/** The line between rows that shows where a dropped track will land. */
function DropIndicator({ active }: { active: boolean }) {
  return <li className={`${styles.dropIndicator} ${active ? styles.dropIndicatorActive : ""}`} aria-hidden />;
}
