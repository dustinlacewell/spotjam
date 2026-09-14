import { useState } from "react";
import type { QueueItem } from "../lib/room";
import { INTERNAL_DRAG_MIME } from "../lib/drop-links";
import { QueueItemCard } from "./QueueItemCard";
import styles from "./QueueLists.module.css";

export function MyQueueList({
  items,
  onMove,
  onSendToTop,
  onRemove,
}: {
  items: QueueItem[];
  onMove: (fromIndex: number, toIndex: number) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (items.length === 0) {
    return <p className={styles.empty}>Your queue is empty. Paste a link below.</p>;
  }

  function handleDrop(toIndex: number) {
    if (dragIndex !== null && dragIndex !== toIndex) onMove(dragIndex, toIndex);
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <ul className={styles.list}>
      {items.map((item, index) => (
        <QueueItemCard
          key={item.id}
          item={item}
          isPlaying={false}
          // Your own queue: every track is yours, so no name chip.
          ownerLabel=""
          draggable
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
