import type { Playlist } from "../lib/playlists";
import type { ParsedLinks, ParsedTrack } from "../lib/spotify-link";
import type { QueueItem } from "../lib/room";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { AddTrackBar } from "./AddTrackBar";
import { QueueItemCard } from "./QueueItemCard";
import { TrackDropZone } from "./TrackDropZone";
import styles from "./PlaylistsPanel.module.css";

export function PlaylistTracks({
  playlist,
  onLinks,
  onRemoveTrack,
  onAddToQueue,
  onReplaceQueue,
  onShuffle,
  importStatus,
}: {
  playlist: Playlist;
  /** Tracks join this playlist; playlist links import as new playlists. */
  onLinks: (links: ParsedLinks) => void;
  onRemoveTrack: (index: number) => void;
  onAddToQueue: () => void;
  onReplaceQueue: () => void;
  /** Randomizes this playlist's stored order. */
  onShuffle: () => void;
  importStatus: string | null;
}) {
  const isEmpty = playlist.tracks.length === 0;

  return (
    <div className={styles.tracksColumn}>
      <div className={styles.tracksHeader}>
        <div className={styles.tracksActions}>
          <button
            type="button"
            className={styles.pillAction}
            disabled={playlist.tracks.length < 2}
            onClick={onShuffle}
          >
            Shuffle
          </button>
          <button
            type="button"
            className={styles.pillAction}
            disabled={isEmpty}
            onClick={onAddToQueue}
          >
            Add to queue
          </button>
          <button
            type="button"
            className={styles.pillAction}
            disabled={isEmpty}
            onClick={onReplaceQueue}
          >
            Replace queue
          </button>
        </div>
      </div>

      <TrackDropZone onLinks={onLinks}>
        <div className={styles.tracksScroll}>
          {isEmpty ? (
            <p className={styles.empty}>
              No tracks yet. Paste a link below or drop tracks here.
            </p>
          ) : (
            <ul className={styles.trackList}>
              {playlist.tracks.map((track, index) => (
                <QueueItemCard
                  key={`${track.trackId}-${index}`}
                  item={cardItem(track, index)}
                  isPlaying={false}
                  ownerLabel=""
                  onRemove={() => onRemoveTrack(index)}
                />
              ))}
            </ul>
          )}
        </div>
      </TrackDropZone>

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
