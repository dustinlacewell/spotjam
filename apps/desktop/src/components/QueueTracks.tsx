import type { ParsedLinks } from "../lib/spotify-link";
import type { QueueItem, SessionEntry } from "../lib/room";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { AddTrackBar } from "./AddTrackBar";
import { MyQueueList } from "./MyQueueList";
import { SessionQueueList } from "./SessionQueueList";
import { UserQueueList } from "./UserQueueList";
import { TrackDropZone } from "./TrackDropZone";
import styles from "./PlaylistsPanel.module.css";

/** Which queue the pane shows, and what may be done to it. */
export type QueueSource =
  | { kind: "session"; entries: SessionEntry[] }
  | { kind: "mine"; items: QueueItem[]; isBroadcasting: boolean }
  | { kind: "other"; items: QueueItem[]; ownerName: string };

export function QueueTracks({
  source,
  importStatus,
  onLinks,
  onMove,
  onSendToTop,
  onRemove,
  onShuffle,
  onClear,
}: {
  source: QueueSource;
  importStatus: string | null;
  /** Tracks join the queue; playlist links import as new playlists. */
  onLinks: (links: ParsedLinks) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  /** Randomizes your queue's play order for every peer. */
  onShuffle: () => void;
  onClear: () => void;
}) {
  const editable = source.kind !== "other";
  const count = source.kind === "session" ? source.entries.length : source.items.length;

  return (
    <div className={styles.tracksColumn}>
      {source.kind === "mine" && count > 0 && (
        <div className={styles.tracksHeader}>
          <div className={styles.tracksActions}>
            <button
              type="button"
              className={styles.pillAction}
              disabled={count < 2}
              onClick={onShuffle}
            >
              Shuffle
            </button>
            <button type="button" className={styles.clearAction} onClick={onClear}>
              Clear
            </button>
          </div>
        </div>
      )}

      {editable ? (
        <TrackDropZone onLinks={onLinks}>
          <div className={styles.tracksScroll}>{listOf(source, { onMove, onSendToTop, onRemove })}</div>
        </TrackDropZone>
      ) : (
        <div className={styles.tracksScroll}>{listOf(source, { onMove, onSendToTop, onRemove })}</div>
      )}

      {source.kind === "mine" && count > 0 && !source.isBroadcasting && (
        <p className={styles.status}>You're not broadcasting — your queue won't play.</p>
      )}

      {editable ? (
        <AddTrackBar
          placeholder="Paste a track or playlist link"
          buttonLabel="Add to queue"
          status={importStatus}
          onAdd={(text) => {
            const links = parseSpotifyLinks(text);
            if (links.tracks.length === 0 && links.playlists.length === 0) {
              return "That doesn't look like a Spotify track or playlist link.";
            }
            onLinks(links);
            return null;
          }}
        />
      ) : (
        importStatus && <p className={styles.status}>{importStatus}</p>
      )}
    </div>
  );
}

function listOf(
  source: QueueSource,
  handlers: {
    onMove: (fromIndex: number, toIndex: number) => void;
    onSendToTop: (itemId: string) => void;
    onRemove: (itemId: string) => void;
  },
): React.ReactNode {
  if (source.kind === "session") return <SessionQueueList entries={source.entries} />;
  if (source.kind === "other") {
    return <UserQueueList items={source.items} ownerName={source.ownerName} />;
  }
  return (
    <MyQueueList
      items={source.items}
      onMove={handlers.onMove}
      onSendToTop={handlers.onSendToTop}
      onRemove={handlers.onRemove}
    />
  );
}
