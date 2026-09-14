import type { SessionEntry } from "../lib/room";
import { QueueItemCard } from "./QueueItemCard";
import styles from "./QueueLists.module.css";

export function SessionQueueList({ entries }: { entries: SessionEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing up next. Broadcasters' queues feed this list.
      </p>
    );
  }

  return (
    <ul className={styles.list}>
      {entries.map((entry) => (
        <QueueItemCard
          key={entry.item.id}
          item={entry.item}
          isPlaying={false}
          ownerLabel={entry.ownerName}
        />
      ))}
    </ul>
  );
}
