import { Card, Chip, IconButton, Thumbnail } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import { useTrackMetadata } from "./use-track-metadata";
import styles from "./QueueItemCard.module.css";

export function QueueItemCard({
  item,
  isPlaying,
  ownerLabel,
  onRemove,
  onSendToTop,
  draggable,
  isDragging,
  isSelected,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  /** The track this card draws; it resolves its own display metadata. */
  item: QueueItem;
  isPlaying: boolean;
  /** The name chip. Empty hides it — your own queue needs no name. */
  ownerLabel?: string;
  onRemove?: () => void;
  onSendToTop?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  /** Part of the current multi-select, so a drag carries it along with the rest. */
  isSelected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const metadata = useTrackMetadata(item.uri);
  const label = (ownerLabel ?? "").trim();

  // Every trailing slot is always rendered so the columns never reflow: an
  // absent control leaves an empty box of the same width, and hover-only
  // buttons fade with opacity rather than leaving the layout.
  return (
    <Card
      as="li"
      interactive={Boolean(draggable)}
      selected={isSelected}
      className={cardClass({ isPlaying, isDragging, draggable })}
      draggable={draggable}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <Thumbnail src={metadata?.thumbnailUrl ?? null} size={44} />
      <div className={styles.info}>
        <p className={styles.title}>{metadata?.title ?? item.trackId}</p>
        <p className={styles.artist}>{metadata?.artist ?? " "}</p>
      </div>
      <span className={styles.ownerSlot}>{label && <Chip>{label}</Chip>}</span>
      <span className={`${styles.actionSlot} ${styles.sendToTopSlot}`} onClick={stopPropagation}>
        {onSendToTop && (
          <IconButton
            label="Send to top"
            onClick={onSendToTop}
            size="sm"
            shape="circle"
            tone="accent"
            revealOnHover
          >
            ▲
          </IconButton>
        )}
      </span>
      <span className={styles.actionSlot} onClick={stopPropagation}>
        {onRemove && (
          <IconButton
            label="Remove from queue"
            onClick={onRemove}
            size="sm"
            shape="circle"
            tone="danger"
            revealOnHover
          >
            ✕
          </IconButton>
        )}
      </span>
    </Card>
  );
}

function stopPropagation(e: React.MouseEvent): void {
  e.stopPropagation();
}

function cardClass({
  isPlaying,
  isDragging,
  draggable,
}: {
  isPlaying: boolean;
  isDragging?: boolean;
  draggable?: boolean;
}): string {
  const names = [styles.card];
  if (draggable) names.push(styles.cardDraggable);
  if (isPlaying) names.push(styles.cardPlaying);
  if (isDragging) names.push(styles.cardDragging);
  return names.join(" ");
}
