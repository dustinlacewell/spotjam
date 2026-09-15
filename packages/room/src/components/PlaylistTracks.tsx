import { Fragment, useRef, useState } from "react";
import { ListPlus, ListStart, RefreshCw, Shuffle, Unlink } from "lucide-react";
import { Button, HintLine, IconButton, TextField } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import type { ParsedLinks, ParsedTrack } from "../lib/spotify-link";
import type { Playlist } from "../lib/playlists";
import type { SyncState } from "./use-playlists";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { carriesTracks, linksFromDrop } from "../lib/drop-links";
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
  readOnly,
  linked = false,
  syncState = "idle",
  onSync,
  onUnlink,
  onLinks,
  onRemoveTrack,
  onAddToQueue,
  onReplaceQueue,
  onShuffle,
  onSetPublic,
  importStatus,
}: {
  playlist: Playlist;
  /**
   * The playlist cannot be edited here: someone else's, or one Spotify owns.
   * It can still be played — queueing copies tracks out rather than changing
   * the playlist.
   */
  readOnly: boolean;
  /**
   * Ours, but mirroring a Spotify playlist. Read-only like a peer's, and
   * additionally syncable and unlinkable.
   */
  linked?: boolean;
  /** How this linked playlist's last sync ended. */
  syncState?: SyncState;
  /** Pulls the Spotify playlist's content again. */
  onSync?: () => void;
  /** Cuts the tie to Spotify, keeping the tracks. */
  onUnlink?: () => void;
  /**
   * Tracks join this playlist at `beforeTrackId` (or the end, when null);
   * playlist links import as new playlists regardless of drop position.
   */
  onLinks: (links: ParsedLinks, beforeTrackId: string | null) => void;
  onRemoveTrack: (index: number) => void;
  onAddToQueue: () => void;
  onReplaceQueue: () => void;
  /** Randomizes this playlist's stored order. */
  onShuffle: () => void;
  /** Shares this playlist with the room, or takes it back. */
  onSetPublic: (isPublic: boolean) => void;
  importStatus: string | null;
}) {
  const [query, setQuery] = useState("");
  // The gap a hovering drag would drop into: an index into visibleTracks
  // (drop before that track), visibleTracks.length (drop at the end), or
  // null while no drag is over the list.
  const [overGap, setOverGap] = useState<number | null>(null);
  // dragenter/dragleave fire for every descendant; count them to know when
  // the drag actually left the zone rather than crossed into a child.
  const dragDepth = useRef(0);
  const isEmpty = playlist.tracks.length === 0;
  const metadataByUri = useTrackMetadataMap(playlist.tracks.map((t) => t.uri));
  const rows = playlist.tracks.map(cardItem);
  const select = useMultiSelect(rows.map((row) => row.id));
  const menu = useTrackContextMenu();
  const filtering = query.trim() !== "";
  const visibleTracks = playlist.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => matchesTrack(query, metadataByUri.get(track.uri), track.trackId));

  function resetDrag() {
    dragDepth.current = 0;
    setOverGap(null);
  }

  function handleDrop(e: React.DragEvent) {
    if (!carriesTracks(e.dataTransfer)) return;
    e.preventDefault();
    const beforeTrackId = overGap === null ? null : (visibleTracks[overGap]?.track.trackId ?? null);
    resetDrag();
    const links = linksFromDrop(e.dataTransfer);
    if (links.tracks.length > 0 || links.playlists.length > 0) onLinks(links, beforeTrackId);
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
        : readOnly
          ? "This playlist has no tracks."
          : "No tracks yet. Paste a link below or drop tracks here."}
    </p>
  ) : visibleTracks.length === 0 ? (
    <p className={styles.empty}>No tracks match "{query}".</p>
  ) : (
    <ul className={styles.trackList}>
      {!filtering && <DropIndicator active={overGap === 0} />}
      {visibleTracks.map(({ index }, position) => {
        const row = rows[index]!;
        return (
        <Fragment key={row.id}>
          <QueueItemCard
            item={row}
            isPlaying={false}
            ownerLabel=""
            isSelected={select.isSelected(row.id)}
            onClick={(e) => select.onRowClick(e, row.id)}
            onContextMenu={(e) => menu.open(e, tracksOf(rows, select.contextTargets(row.id)))}
            onRemove={readOnly ? undefined : () => onRemoveTrack(index)}
            onDragOver={
              readOnly || filtering
                ? undefined
                : (e) => {
                    if (!carriesTracks(e.dataTransfer)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
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
          {/* Sharing is ours to decide even when Spotify owns the content. */}
          {linked && (
            <>
              <PublicToggle
                isPublic={playlist.isPublic}
                onToggle={() => onSetPublic(!playlist.isPublic)}
              />
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
                onClick={onUnlink}
              >
                <Unlink size={16} strokeWidth={2} />
              </IconButton>
            </>
          )}
          {!readOnly && (
            <>
              <PublicToggle
                isPublic={playlist.isPublic}
                onToggle={() => onSetPublic(!playlist.isPublic)}
              />
              {/* Shuffle rewrites the stored order, which a sync would throw
                  away — so a linked playlist does not offer it. */}
              <IconButton
                label="Shuffle"
                shape="square"
                size="md"
                tone="neutral"
                disabled={playlist.tracks.length < 2}
                onClick={onShuffle}
              >
                <Shuffle size={16} strokeWidth={2} />
              </IconButton>
            </>
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
        </div>
      </div>

      {readOnly ? (
        <div className={styles.tracksScroll}>{body}</div>
      ) : (
        <div
          className={styles.tracksScroll}
          onDragEnter={(e) => {
            if (!carriesTracks(e.dataTransfer)) return;
            dragDepth.current += 1;
          }}
          onDragOver={(e) => {
            if (!carriesTracks(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (!carriesTracks(e.dataTransfer)) return;
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) resetDrag();
          }}
          onDrop={handleDrop}
        >
          {body}
        </div>
      )}

      {readOnly ? (
        importStatus && <HintLine tone="muted">{importStatus}</HintLine>
      ) : (
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
      )}

      <TrackContextMenu at={menu.at} tracks={menu.tracks} onClose={menu.close} />
    </div>
  );
}

/** QueueItemCard renders QueueItems; a playlist track has no queue identity. */
function cardItem(track: ParsedTrack): QueueItem {
  return {
    id: track.trackId,
    uri: track.uri,
    trackId: track.trackId,
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
