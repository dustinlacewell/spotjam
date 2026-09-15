import { useEffect, useState } from "react";
import type { ParsedLinks, ParsedTrack } from "../lib/spotify-link";
import type { PlaylistsApi } from "./use-playlists";
import { PlaylistList } from "./PlaylistList";
import { PlaylistTracks } from "./PlaylistTracks";
import { QueueTracks, type QueueSource } from "./QueueTracks";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import styles from "./PlaylistsPanel.module.css";

/**
 * One detail page: a list of the owner's playlists with their live queue pinned
 * at the top, and whichever of those is selected filling the pane beside it.
 * Another person's page shows the same shape read-only — we hold no playlists
 * but our own, so theirs is the queue row alone.
 */
export function DetailPane({
  api,
  queue,
  selected,
  onSelect,
  onAddToQueue,
  onReplaceQueue,
  onQueueLinks,
  onLinks,
  onMove,
  onSendToTop,
  onRemove,
  onShuffleQueue,
  onClear,
  importStatus,
}: {
  api: PlaylistsApi;
  queue: QueueSource;
  /** Owned by QueueView so an import can open the playlist it just made. */
  selected: PaneSelection;
  onSelect: (selection: PaneSelection) => void;
  onAddToQueue: (tracks: ParsedTrack[]) => void;
  onReplaceQueue: (tracks: ParsedTrack[]) => void;
  /** Links dropped or pasted on the queue pane. */
  onQueueLinks: (links: ParsedLinks) => void;
  /** Tracks land in the open playlist; playlist links import as new playlists. */
  onLinks: (links: ParsedLinks, onTracks: (tracks: ParsedTrack[]) => void) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  /** Randomizes your queue's play order. A playlist shuffles through the api. */
  onShuffleQueue: () => void;
  onClear: () => void;
  importStatus: string | null;
}) {
  const { playlists, create, remove, rename, addTracks, removeTrack, shuffle } = api;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);

  // Playlists are ours wherever we are, so the session page keeps them. Another
  // person's page holds none of ours: their queue row stands alone, read-only.
  const readOnly = queue.kind === "other";
  const visiblePlaylists = readOnly ? [] : playlists;
  const openPlaylist = visiblePlaylists.find((p) => p.id === selected) ?? null;

  // A new playlist opens selected and in rename mode once the hook's state lands.
  useEffect(() => {
    if (!pendingName) return;
    const fresh = playlists.find((p) => p.name === pendingName);
    if (!fresh) return;
    setPendingName(null);
    onSelect(fresh.id);
    setRenamingId(fresh.id);
  }, [pendingName, playlists, onSelect]);

  function handleCreate() {
    const name = defaultName(playlists.map((p) => p.name));
    create(name);
    setRenamingId(null);
    setPendingName(name);
  }

  return (
    <div className={styles.panel}>
      <PlaylistList
        playlists={visiblePlaylists}
        queueCount={countOf(queue)}
        selected={selected}
        renamingId={renamingId}
        readOnly={readOnly}
        onSelect={onSelect}
        onStartRename={setRenamingId}
        onCommitRename={(id, name) => {
          rename(id, name);
          setRenamingId(null);
        }}
        onCancelRename={() => setRenamingId(null)}
        onDelete={(id) => {
          remove(id);
          if (id === selected) onSelect(QUEUE_PANE);
          if (id === renamingId) setRenamingId(null);
        }}
        onCreate={handleCreate}
      />

      {openPlaylist ? (
        <PlaylistTracks
          playlist={openPlaylist}
          onLinks={(links) => onLinks(links, (tracks) => addTracks(openPlaylist.id, tracks))}
          onRemoveTrack={(index) => removeTrack(openPlaylist.id, index)}
          onAddToQueue={() => onAddToQueue(openPlaylist.tracks)}
          onReplaceQueue={() => onReplaceQueue(openPlaylist.tracks)}
          onShuffle={() => shuffle(openPlaylist.id)}
          importStatus={importStatus}
        />
      ) : (
        <QueueTracks
          source={queue}
          importStatus={importStatus}
          onLinks={onQueueLinks}
          onMove={onMove}
          onSendToTop={onSendToTop}
          onRemove={onRemove}
          onShuffle={onShuffleQueue}
          onClear={onClear}
        />
      )}
    </div>
  );
}

function countOf(queue: QueueSource): number {
  return queue.kind === "session" ? queue.entries.length : queue.items.length;
}

/** "Untitled", then "Untitled 2", "Untitled 3", ... */
function defaultName(existing: string[]): string {
  if (!existing.includes("Untitled")) return "Untitled";
  for (let n = 2; ; n += 1) {
    const candidate = `Untitled ${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
