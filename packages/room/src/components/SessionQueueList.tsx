import type { SessionEntry } from "@spotjam/protocol";
import { tracksOf } from "../lib/selection";
import { QueueItemCard } from "./QueueItemCard";
import { TrackContextMenu } from "./TrackContextMenu";
import { useMultiSelect } from "./use-multi-select";
import { useTrackContextMenu } from "./use-track-context-menu";
import styles from "./QueueLists.module.css";

export function SessionQueueList({ entries }: { entries: SessionEntry[] }) {
  const items = entries.map((entry) => entry.item);
  const select = useMultiSelect(items.map((item) => item.id));
  const menu = useTrackContextMenu();

  if (entries.length === 0) {
    return (
      <p className={styles.empty}>Drop a song or playlist here.</p>
    );
  }

  return (
    <>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <QueueItemCard
            key={entry.item.id}
            item={entry.item}
            isPlaying={false}
            ownerLabel={entry.ownerName}
            isSelected={select.isSelected(entry.item.id)}
            onClick={(e) => select.onRowClick(e, entry.item.id)}
            onContextMenu={(e) => menu.open(e, tracksOf(items, select.contextTargets(entry.item.id)))}
          />
        ))}
      </ul>
      <TrackContextMenu at={menu.at} tracks={menu.tracks} onClose={menu.close} />
    </>
  );
}
