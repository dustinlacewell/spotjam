import { useEffect, useMemo, useState } from "react";
import type { SharedPlaylist } from "@spotjam/protocol";
import type { Playlist } from "../lib/playlists";
import type { ParsedLinks, ParsedPlaylist, ParsedTrack } from "../lib/spotify-link";
import type { PlaylistsApi } from "./use-playlists";
import { canEditItems, defaultPlaylistName, isEditable, tracksOf } from "../lib/playlists";
import { PlaylistList } from "./PlaylistList";
import { PlaylistTracks } from "./PlaylistTracks";
import { QueueTracks, type QueueSource } from "./QueueTracks";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import styles from "./PlaylistsPanel.module.css";

/**
 * One detail page: a list of the owner's playlists with their live queue pinned
 * at the top, and whichever of those is selected filling the pane beside it.
 * Another person's page shows the same shape read-only, listing whichever of
 * their playlists they made public.
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
  onLinkPlaylist,
  onImportPlaylists,
  onMoveMany,
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
  /** Opens the dialog that links a Spotify playlist. */
  onLinkPlaylist: () => void;
  /** A playlist link dropped on the playlist list asks whether to copy or link it. */
  onImportPlaylists: (playlists: ParsedPlaylist[]) => void;
  onMoveMany: (itemIds: string[], beforeItemId: string | null) => void;
  onSendToTop: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  /** Randomizes your queue's play order. A playlist shuffles through the api. */
  onShuffleQueue: () => void;
  onClear: () => void;
  importStatus: string | null;
}) {
  const {
    playlists,
    create,
    remove,
    rename,
    insertTracks,
    removeTrack,
    shuffle,
    setPublic,
    sync,
    unlink,
    syncStateOf,
    moveRow,
  } = api;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);

  // Our own page lists our playlists; someone else's lists whichever of theirs
  // the room holds, which is only the ones they made public.
  const readOnly = queue.kind === "other";
  const visiblePlaylists = useMemo(
    () => (queue.kind === "other" ? queue.playlists.map(asPlaylist) : playlists),
    [queue, playlists],
  );
  const openPlaylist = visiblePlaylists.find((p) => p.id === selected) ?? null;

  // Someone else's page can only be looked at. On our own, a linked playlist's
  // rows are editable whenever Spotify lets us write to them: the edit goes
  // there and comes back on the sync.
  const canEditOpen = !readOnly && openPlaylist !== null && canEditItems(openPlaylist);

  // Opening a linked playlist refreshes it. The fetch is a local call to the
  // running client, so this costs a round trip on this machine and nothing
  // else; the hook ignores a second call while one is in flight.
  const openLinkedId = !readOnly && openPlaylist && !isEditable(openPlaylist) ? openPlaylist.id : null;
  useEffect(() => {
    if (openLinkedId) sync(openLinkedId);
  }, [openLinkedId, sync]);

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
    const name = defaultPlaylistName(playlists.map((p) => p.name));
    create(name);
    setRenamingId(null);
    setPendingName(name);
  }

  return (
    <div className={styles.panel}>
      <PlaylistList
        playlists={visiblePlaylists}
        queueCount={countOf(queue)}
        queueLabel={queue.kind === "other" ? `${queue.ownerName}'s queue` : "Your queue"}
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
        onCreate={handleCreate}
        onLinkPlaylist={onLinkPlaylist}
        onImportPlaylists={onImportPlaylists}
      />

      {openPlaylist ? (
        <PlaylistTracks
          // Each playlist gets its own pane state. Without this, a search
          // and a half-answered confirmation would carry over to the next
          // playlist opened, and the confirmation would act on the wrong one.
          key={openPlaylist.id}
          playlist={openPlaylist}
          canEdit={canEditOpen}
          linked={!readOnly && !isEditable(openPlaylist)}
          syncState={syncStateOf(openPlaylist.id)}
          onSync={() => sync(openPlaylist.id)}
          onUnlink={() => unlink(openPlaylist.id)}
          onDelete={
            readOnly
              ? undefined
              : () => {
                  remove(openPlaylist.id);
                  onSelect(QUEUE_PANE);
                  if (openPlaylist.id === renamingId) setRenamingId(null);
                }
          }
          onLinks={(links, beforeTrackId) =>
            onLinks(links, (tracks) => insertTracks(openPlaylist.id, tracks, beforeTrackId))
          }
          onRemoveTrack={(index) => removeTrack(openPlaylist.id, index)}
          onMoveRow={(trackId, beforeTrackId) =>
            moveRow(openPlaylist.id, trackId, beforeTrackId)
          }
          onAddToQueue={() => onAddToQueue(tracksOf(openPlaylist))}
          onReplaceQueue={() => onReplaceQueue(tracksOf(openPlaylist))}
          onShuffle={() => shuffle(openPlaylist.id)}
          onSetPublic={(isPublic) => setPublic(openPlaylist.id, isPublic)}
          importStatus={importStatus}
        />
      ) : (
        <QueueTracks
          source={queue}
          importStatus={importStatus}
          onLinks={onQueueLinks}
          onMoveMany={onMoveMany}
          onSendToTop={onSendToTop}
          onRemove={onRemove}
          onShuffle={onShuffleQueue}
          onClear={onClear}
        />
      )}
    </div>
  );
}

/**
 * A shared playlist, in the shape the panel renders.
 *
 * It only ever reached us because its owner made it public, so `isPublic` is
 * true by construction. Nothing here can change that flag: the page is read-only.
 */
function asPlaylist(shared: SharedPlaylist): Playlist {
  return {
    id: shared.id,
    name: shared.name,
    rows: shared.tracks.map((track) => ({
      track: { uri: track.uri, trackId: track.trackId },
    })),
    isPublic: true,
    // A peer's playlist is a copy of their tracks. Whether they keep it linked
    // to Spotify is their business and never reaches the wire.
    source: { kind: "local" },
  };
}

function countOf(queue: QueueSource): number {
  return queue.kind === "session" ? queue.entries.length : queue.items.length;
}
