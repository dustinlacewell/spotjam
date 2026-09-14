import type { QueueItem } from "../lib/room";
import { QueueItemCard } from "./QueueItemCard";
import styles from "./QueueLists.module.css";

export function UserQueueList({
  items,
  ownerName,
}: {
  items: QueueItem[];
  ownerName: string;
}) {
  if (items.length === 0) {
    return <p className={styles.empty}>{ownerName} has nothing queued.</p>;
  }

  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <QueueItemCard
          key={item.id}
          item={item}
          isPlaying={false}
          ownerLabel={ownerName}
        />
      ))}
    </ul>
  );
}
