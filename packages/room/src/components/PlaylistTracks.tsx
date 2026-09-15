import { useState } from "react";
import { ListPlus, ListStart, Shuffle } from "lucide-react";
import { HintLine, IconButton, TextField } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import type { ParsedLinks, ParsedTrack } from "../lib/spotify-link";
import type { Playlist } from "../lib/playlists";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { matchesTrack } from "../lib/track-search";
import { AddTrackBar } from "./AddTrackBar";
import { PublicToggle } from "./PublicToggle";
import { QueueItemCard } from "./QueueItemCard";
import { TrackDropZone } from "./TrackDropZone";
import { useTrackMetadataMap } from "./use-track-metadata";
import styles from "./PlaylistsPanel.module.css";

export function PlaylistTracks({
  playlist,
  readOnly,
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
   * Someone else's playlist: it can be played, never edited. Only the owner
   * changes its tracks, its order, or whether the room can see it.
   */
  readOnly: boolean;
  /** Tracks join this playlist; playlist links import as new playlists. */
  onLinks: (links: ParsedLinks) => void;
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
  const isEmpty = playlist.tracks.length === 0;
  const metadataByUri = useTrackMetadataMap(playlist.tracks.map((t) => t.uri));
  const visibleTracks = playlist.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => matchesTrack(query, metadataByUri.get(track.uri), track.trackId));

  const body = isEmpty ? (
    <p className={styles.empty}>
      {readOnly
        ? "This playlist has no tracks."
        : "No tracks yet. Paste a link below or drop tracks here."}
    </p>
  ) : visibleTracks.length === 0 ? (
    <p className={styles.empty}>No tracks match "{query}".</p>
  ) : (
    <ul className={styles.trackList}>
      {visibleTracks.map(({ track, index }) => (
        <QueueItemCard
          key={`${track.trackId}-${index}`}
          item={cardItem(track, index)}
          isPlaying={false}
          ownerLabel=""
          onRemove={readOnly ? undefined : () => onRemoveTrack(index)}
        />
      ))}
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
          {!readOnly && (
            <>
              <PublicToggle
                isPublic={playlist.isPublic}
                onToggle={() => onSetPublic(!playlist.isPublic)}
              />
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
        <TrackDropZone onLinks={onLinks}>
          <div className={styles.tracksScroll}>{body}</div>
        </TrackDropZone>
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
            onLinks(links);
            return null;
          }}
        />
      )}
    </div>
  );
}

/** QueueItemCard renders QueueItems; a playlist track has no queue identity. */
function cardItem(track: ParsedTrack, index: number): QueueItem {
  return {
    id: `${track.trackId}-${index}`,
    uri: track.uri,
    trackId: track.trackId,
  };
}
