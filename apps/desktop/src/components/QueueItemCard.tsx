import type { QueueItem } from "../lib/room";
import { useTrackMetadata } from "../lib/use-track-metadata";
import styles from "./QueueItemCard.module.css";

export function QueueItemCard({
  item,
  isPlaying,
  ownerLabel,
  onRemove,
  onSendToTop,
  draggable,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  item: QueueItem;
  isPlaying: boolean;
  /** Overrides the `addedBy` chip; use the queue owner's name in session views. */
  ownerLabel?: string;
  onRemove?: () => void;
  onSendToTop?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const metadata = useTrackMetadata(item.uri);
  const label = (ownerLabel ?? item.addedBy).trim();

  // Every trailing slot is always rendered so the columns never reflow: an
  // absent control leaves an empty box of the same width, and hover-only
  // buttons fade with opacity rather than leaving the layout.
  return (
    <li
      className={cardClass({ isPlaying, isDragging, isDropTarget, draggable })}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className={styles.art}>
        {metadata?.thumbnailUrl && <img src={metadata.thumbnailUrl} alt="" />}
      </div>
      <div className={styles.info}>
        <p className={styles.title}>{metadata?.title ?? item.trackId}</p>
        <p className={styles.artist}>{metadata?.artist ?? " "}</p>
      </div>
      <span className={styles.ownerSlot}>
        {label && <span className={styles.addedBy}>{label}</span>}
      </span>
      <span className={styles.actionSlot}>
        {onSendToTop && (
          <button
            className={styles.action}
            onClick={onSendToTop}
            aria-label="Send to top of your queue"
            title="Send to top"
          >
            ▲
          </button>
        )}
      </span>
      <span className={styles.actionSlot}>
        {onRemove && (
          <button
            className={styles.remove}
            onClick={onRemove}
            aria-label="Remove from queue"
          >
            ✕
          </button>
        )}
      </span>
    </li>
  );
}

function cardClass({
  isPlaying,
  isDragging,
  isDropTarget,
  draggable,
}: {
  isPlaying: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  draggable?: boolean;
}): string {
  const names = [styles.card];
  if (draggable) names.push(styles.cardDraggable);
  if (isPlaying) names.push(styles.cardPlaying);
  if (isDragging) names.push(styles.cardDragging);
  if (isDropTarget) names.push(styles.cardDropTarget);
  return names.join(" ");
}
