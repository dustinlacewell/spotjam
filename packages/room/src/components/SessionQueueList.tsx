import type { SessionEntry } from "@spotjam/protocol";
import { QueueItemCard } from "./QueueItemCard";
import styles from "./QueueLists.module.css";

export function SessionQueueList({ entries }: { entries: SessionEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className={styles.empty}>Drop a song or playlist here.</p>
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
