import { useState } from "react";
import { HintLine, Pill, TextField } from "@spotjam/ui";
import type { QueueItem, SessionEntry, SharedPlaylist } from "@spotjam/protocol";
import type { ParsedLinks } from "../lib/spotify-link";
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
  | {
      kind: "other";
      items: QueueItem[];
      ownerName: string;
      /** Whichever of their playlists they made public. */
      playlists: SharedPlaylist[];
    };

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
  const [query, setQuery] = useState("");

  return (
    <div className={styles.tracksColumn}>
      {source.kind === "mine" && count > 0 && (
        <div className={styles.tracksHeader}>
          <TextField
            value={query}
            onChange={setQuery}
            placeholder="Search your queue"
            size="sm"
            spellCheck={false}
          />
          <div className={styles.tracksActions}>
            <Pill disabled={count < 2} onClick={onShuffle}>
              Shuffle
            </Pill>
            <Pill tone="danger" onClick={onClear}>
              Clear
            </Pill>
          </div>
        </div>
      )}

      {editable ? (
        <TrackDropZone onLinks={onLinks}>
          <div className={styles.tracksScroll}>
            {listOf(source, { query, onMove, onSendToTop, onRemove })}
          </div>
        </TrackDropZone>
      ) : (
        <div className={styles.tracksScroll}>
          {listOf(source, { query, onMove, onSendToTop, onRemove })}
        </div>
      )}

      {source.kind === "mine" && count > 0 && !source.isBroadcasting && (
        <HintLine tone="muted">You're not broadcasting — your queue won't play.</HintLine>
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
        importStatus && <HintLine tone="muted">{importStatus}</HintLine>
      )}
    </div>
  );
}

function listOf(
  source: QueueSource,
  handlers: {
    query: string;
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
      query={handlers.query}
      onMove={handlers.onMove}
      onSendToTop={handlers.onSendToTop}
      onRemove={handlers.onRemove}
    />
  );
}
