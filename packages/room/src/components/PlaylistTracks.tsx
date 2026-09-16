import { Fragment, useRef, useState } from "react";
import { ListPlus, ListStart, RefreshCw, Shuffle, Trash2, Unlink } from "lucide-react";
import { Button, ConfirmModal, HintLine, IconButton, TextField } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import type { ParsedLinks } from "../lib/spotify-link";
import type { Playlist, PlaylistRow } from "../lib/playlists";
import type { SyncState } from "./use-playlists";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { INTERNAL_DRAG_MIME, carriesTracks, linksFromDrop } from "../lib/drop-links";
import { tracksOf } from "../lib/selection";
import { matchesTrack } from "../lib/track-search";
import { AddTrackBar } from "./AddTrackBar";
import { PublicToggle } from "./PublicToggle";
import { QueueItemCard } from "./QueueItemCard";
import { TrackContextMenu } from "./TrackContextMenu";
import { useMultiSelect } from "./use-multi-select";
import { useTrackContextMenu } from "./use-track-context-menu";
import { useTrackMetadataMap } from "./use-track-metadata";
import styles from "./PlaylistsPanel.module.css";
import listStyles from "./QueueLists.module.css";

export function PlaylistTracks({
  playlist,
  canEdit,
  linked = false,
  syncState = "idle",
  onSync,
  onUnlink,
  onDelete,
  onLinks,
  onRemoveTrack,
  onMoveRow,
  onAddToQueue,
  onReplaceQueue,
  onShuffle,
  onSetPublic,
  importStatus,
}: {
  playlist: Playlist;
  /**
   * Whether this install may change which rows the playlist holds, and in what
   * order. False for someone else's, and for a linked playlist Spotify will
   * not let us write to. Queueing is never gated by it: that copies tracks out
   * rather than changing the playlist.
   */
  canEdit: boolean;
  /**
   * Ours, but mirroring a Spotify playlist. Syncable and unlinkable, and every
   * edit is written to Spotify rather than here.
   */
  linked?: boolean;
  /** How this linked playlist's last sync ended. */
  syncState?: SyncState;
  /** Pulls the Spotify playlist's content again. */
  onSync?: () => void;
  /** Cuts the tie to Spotify, keeping the tracks. */
  onUnlink?: () => void;
  /**
   * Deletes this playlist from our page. Absent on someone else's, which is
   * the only place deleting is refused: a linked playlist Spotify will not
   * let us edit is still ours to drop.
   */
  onDelete?: () => void;
  /**
   * Tracks join this playlist at `beforeTrackId` (or the end, when null);
   * playlist links import as new playlists regardless of drop position.
   */
  onLinks: (links: ParsedLinks, beforeTrackId: string | null) => void;
  onRemoveTrack: (index: number) => void;
  /** Moves a row to sit before `beforeTrackId`, or to the end when null. */
  onMoveRow: (trackId: string, beforeTrackId: string | null) => void;
  onAddToQueue: () => void;
  onReplaceQueue: () => void;
  /** Randomizes this playlist's stored order. */
  onShuffle: () => void;
  /** Shares this playlist with the room, or takes it back. */
  onSetPublic: (isPublic: boolean) => void;
  importStatus: string | null;
}) {
  const [query, setQuery] = useState("");
  // Which toolbar act is waiting on the user's confirmation, if any. Both
  // acts throw work away, and neither page can put it back.
  const [confirming, setConfirming] = useState<"delete" | "unlink" | null>(null);
  // The gap a hovering drag would drop into: an index into visibleRows (drop
  // before that row), visibleRows.length (drop at the end), or null while no
  // drag is over the list.
  const [overGap, setOverGap] = useState<number | null>(null);
  // The row being dragged within this list, if any. An external track drag
  // leaves it null, which is what tells the drop which meaning it has.
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  // dragenter/dragleave fire for every descendant; count them to know when
  // the drag actually left the zone rather than crossed into a child.
  const dragDepth = useRef(0);
  const isEmpty = playlist.rows.length === 0;
  const metadataByUri = useTrackMetadataMap(playlist.rows.map((row) => row.track.uri));
  const cards = playlist.rows.map(cardItem);
  const select = useMultiSelect(cards.map((card) => card.id));
  const menu = useTrackContextMenu();
  const filtering = query.trim() !== "";
  const visibleRows = playlist.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      matchesTrack(query, metadataByUri.get(row.track.uri), row.track.trackId),
    );

  function resetDrag() {
    dragDepth.current = 0;
    setOverGap(null);
    setDraggedTrackId(null);
  }

  /** The track a drop at `gap` should land before, or null for the end. */
  function beforeTrackIdAt(gap: number | null): string | null {
    if (gap === null) return null;
    return visibleRows[gap]?.row.track.trackId ?? null;
  }

  function handleDrop(e: React.DragEvent) {
    // A row dragged within this list reorders; anything else is an import.
    if (draggedTrackId !== null) {
      e.preventDefault();
      const before = beforeTrackIdAt(overGap);
      const trackId = draggedTrackId;
      resetDrag();
      if (before !== trackId) onMoveRow(trackId, before);
      return;
    }

    if (!carriesTracks(e.dataTransfer)) return;
    e.preventDefault();
    const beforeTrackId = beforeTrackIdAt(overGap);
    resetDrag();
    const links = linksFromDrop(e.dataTransfer);
    if (links.tracks.length > 0 || links.playlists.length > 0) onLinks(links, beforeTrackId);
  }

  /** True while a drag this list can act on is in progress. */
  function acceptsDrag(e: React.DragEvent): boolean {
    return draggedTrackId !== null || carriesTracks(e.dataTransfer);
  }

  // A linked playlist we could not reach says so in place of its tracks: an
  // empty list would read as "Spotify emptied this playlist", which is the one
  // thing we do not know.
  const body = linked && syncState === "unreachable" ? (
    <div className={styles.empty}>
      <p>Can't connect to Spotify.</p>
      <Button variant="secondary" size="sm" onClick={onSync}>
        Sync
      </Button>
    </div>
  ) : isEmpty ? (
    <p className={styles.empty}>
      {linked
        ? "This Spotify playlist has no tracks."
        : canEdit
          ? "No tracks yet. Paste a link below or drop tracks here."
          : "This playlist has no tracks."}
    </p>
  ) : visibleRows.length === 0 ? (
    <p className={styles.empty}>No tracks match "{query}".</p>
  ) : (
    <ul className={styles.trackList}>
      {!filtering && <DropIndicator active={overGap === 0} />}
      {visibleRows.map(({ row, index }, position) => {
        const card = cards[index]!;
        return (
        <Fragment key={card.id}>
          <QueueItemCard
            item={card}
            isPlaying={false}
            ownerLabel=""
            isSelected={select.isSelected(card.id)}
            isDragging={draggedTrackId === row.track.trackId}
            // Reordering a filtered list would move rows the user cannot see.
            draggable={canEdit && !filtering}
            onClick={(e) => select.onRowClick(e, card.id)}
            onContextMenu={(e) => menu.open(e, tracksOf(cards, select.contextTargets(card.id)))}
            onRemove={canEdit ? () => onRemoveTrack(index) : undefined}
            onDragStart={
              canEdit && !filtering
                ? (e) => {
                    setDraggedTrackId(row.track.trackId);
                    e.dataTransfer.effectAllowed = "move";
                    // Marks the drag as ours so track drop zones ignore it.
                    e.dataTransfer.setData(INTERNAL_DRAG_MIME, row.track.trackId);
                    // Firefox refuses to start a drag without payload.
                    e.dataTransfer.setData("text/plain", row.track.trackId);
                  }
                : undefined
            }
            onDragEnd={canEdit ? resetDrag : undefined}
            onDragOver={
              !canEdit || filtering
                ? undefined
                : (e) => {
                    if (!acceptsDrag(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = draggedTrackId === null ? "copy" : "move";
                    const bounds = e.currentTarget.getBoundingClientRect();
                    const isTopHalf = e.clientY < bounds.top + bounds.height / 2;
                    setOverGap(isTopHalf ? position : position + 1);
                  }
            }
          />
          {!filtering && <DropIndicator active={overGap === position + 1} />}
        </Fragment>
        );
      })}
    </ul>
  );

  return (
    <div className={styles.tracksColumn}>
      <div className={styles.tracksHeader}>
        {!isEmpty && (
          <TextField
            value={query}
            onChange={setQuery}
            placeholder="Search tracks"
            size="sm"
            spellCheck={false}
          />
        )}
        <div className={styles.tracksActions}>
          {/* Sharing is ours to decide however the content is owned, so this
              shows for a linked playlist as much as a local one. */}
          {(linked || canEdit) && (
            <PublicToggle
              isPublic={playlist.isPublic}
              onToggle={() => onSetPublic(!playlist.isPublic)}
            />
          )}
          {linked && (
            <>
              <IconButton
                label="Sync from Spotify"
                shape="square"
                size="md"
                tone="neutral"
                disabled={syncState === "syncing"}
                onClick={onSync}
              >
                <RefreshCw size={16} strokeWidth={2} />
              </IconButton>
              <IconButton
                label="Unlink from Spotify"
                shape="square"
                size="md"
                tone="neutral"
                onClick={() => setConfirming("unlink")}
              >
                <Unlink size={16} strokeWidth={2} />
              </IconButton>
            </>
          )}
          {/* Shuffle rewrites the whole order at once. On a linked playlist
              that would be one Spotify call per row, so it stays local-only. */}
          {!linked && canEdit && (
            <IconButton
              label="Shuffle"
              shape="square"
              size="md"
              tone="neutral"
              disabled={playlist.rows.length < 2}
              onClick={onShuffle}
            >
              <Shuffle size={16} strokeWidth={2} />
            </IconButton>
          )}
          <IconButton
            label="Add to queue"
            shape="square"
            size="md"
            tone="neutral"
            disabled={isEmpty}
            onClick={onAddToQueue}
          >
            <ListPlus size={16} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Replace queue"
            shape="square"
            size="md"
            tone="neutral"
            disabled={isEmpty}
            onClick={onReplaceQueue}
          >
            <ListStart size={16} strokeWidth={2} />
          </IconButton>
          {onDelete && (
            <IconButton
              label={`Delete ${playlist.name}`}
              shape="square"
              size="md"
              tone="danger"
              onClick={() => setConfirming("delete")}
            >
              <Trash2 size={16} strokeWidth={2} />
            </IconButton>
          )}
        </div>
      </div>

      {canEdit ? (
        <div
          className={styles.tracksScroll}
          onDragEnter={(e) => {
            if (!acceptsDrag(e)) return;
            dragDepth.current += 1;
          }}
          onDragOver={(e) => {
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = draggedTrackId === null ? "copy" : "move";
          }}
          onDragLeave={(e) => {
            if (!acceptsDrag(e)) return;
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) resetDrag();
          }}
          onDrop={handleDrop}
        >
          {body}
        </div>
      ) : (
        <div className={styles.tracksScroll}>{body}</div>
      )}

      {canEdit ? (
        <AddTrackBar
          placeholder="Paste a track or playlist link"
          buttonLabel="Add to playlist"
          status={importStatus}
          onAdd={(text) => {
            const links = parseSpotifyLinks(text);
            if (links.tracks.length === 0 && links.playlists.length === 0) {
              return "That doesn't look like a Spotify track or playlist link.";
            }
            onLinks(links, null);
            return null;
          }}
        />
      ) : (
        importStatus && <HintLine tone="muted">{importStatus}</HintLine>
      )}

      <TrackContextMenu at={menu.at} tracks={menu.tracks} onClose={menu.close} />

      <ConfirmModal
        open={confirming === "delete"}
        title={`Delete "${playlist.name}"?`}
        confirmLabel="Delete"
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          onDelete?.();
        }}
      >
        {linked
          ? "This drops the playlist from your page. The Spotify playlist it mirrors stays where it is."
          : "This drops the playlist and its tracks. You can't get them back."}
      </ConfirmModal>

      <ConfirmModal
        open={confirming === "unlink"}
        title={`Unlink "${playlist.name}"?`}
        confirmLabel="Unlink"
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          onUnlink?.();
        }}
      >
        This keeps the tracks as an ordinary playlist and stops syncing. Your
        edits will no longer reach Spotify.
      </ConfirmModal>
    </div>
  );
}

/** QueueItemCard renders QueueItems; a playlist row has no queue identity. */
function cardItem(row: PlaylistRow): QueueItem {
  return {
    id: row.track.trackId,
    uri: row.track.uri,
    trackId: row.track.trackId,
    durationMs: row.track.durationMs,
  };
}

/** The line between rows that shows where a dropped track will land. */
function DropIndicator({ active }: { active: boolean }) {
  return (
    <li
      className={`${listStyles.dropIndicator} ${active ? listStyles.dropIndicatorActive : ""}`}
      aria-hidden
    />
  );
}
