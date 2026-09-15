import type { QueueItem } from "@spotjam/protocol";
import { tracksOf } from "../lib/selection";
import { QueueItemCard } from "./QueueItemCard";
import { TrackContextMenu } from "./TrackContextMenu";
import { useMultiSelect } from "./use-multi-select";
import { useTrackContextMenu } from "./use-track-context-menu";
import styles from "./QueueLists.module.css";

export function UserQueueList({
  items,
  ownerName,
}: {
  items: QueueItem[];
  ownerName: string;
}) {
  const select = useMultiSelect(items.map((item) => item.id));
  const menu = useTrackContextMenu();

  if (items.length === 0) {
    return <p className={styles.empty}>{ownerName} has nothing queued.</p>;
  }

  return (
    <>
      <ul className={styles.list}>
        {items.map((item) => (
          <QueueItemCard
            key={item.id}
            item={item}
            isPlaying={false}
            ownerLabel={ownerName}
            isSelected={select.isSelected(item.id)}
            onClick={(e) => select.onRowClick(e, item.id)}
            onContextMenu={(e) => menu.open(e, tracksOf(items, select.contextTargets(item.id)))}
          />
        ))}
      </ul>
      <TrackContextMenu at={menu.at} tracks={menu.tracks} onClose={menu.close} />
    </>
  );
}
