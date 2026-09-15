import { useState } from "react";
import type { QueueItem } from "@spotjam/protocol";
import { INTERNAL_DRAG_MIME } from "../lib/drop-links";
import { matchesTrack } from "../lib/track-search";
import { QueueItemCard } from "./QueueItemCard";
import { useTrackMetadataMap } from "./use-track-metadata";
import styles from "./QueueLists.module.css";

export function MyQueueList({
  items,
  query,
  onMove,
  onSendToTop,
  onRemove,
}: {
  items: QueueItem[];
  /** Filters the visible list; reordering stays disabled while it's non-empty. */
  query: string;
  onMove: (fromIndex: number, toIndex: number) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
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

  function handleDrop(toIndex: number) {
    if (dragIndex !== null && dragIndex !== toIndex) onMove(dragIndex, toIndex);
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <ul className={styles.list}>
      {visibleItems.map(({ item, index }) => (
        <QueueItemCard
          key={item.id}
          item={item}
          isPlaying={false}
          // Your own queue: every track is yours, so no name chip.
          ownerLabel=""
          draggable={!filtering}
          isDragging={dragIndex === index}
          isDropTarget={overIndex === index && dragIndex !== index}
          onDragStart={(e) => {
            setDragIndex(index);
            e.dataTransfer.effectAllowed = "move";
            // Marks the drag as ours so track drop zones ignore it.
            e.dataTransfer.setData(INTERNAL_DRAG_MIME, item.id);
            // Firefox refuses to start a drag without payload.
            e.dataTransfer.setData("text/plain", item.id);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOverIndex(index);
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(index);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          onSendToTop={index === 0 ? undefined : () => onSendToTop(item.id)}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </ul>
  );
}
