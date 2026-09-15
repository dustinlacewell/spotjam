import { useState } from "react";
import { ContextMenu, ContextMenuItem, type Point } from "@spotjam/ui";
import type { PlaylistTrack } from "@spotjam/protocol";
import { canAddTracks, defaultPlaylistName } from "../lib/playlists";
import { filterPlaylists, shouldShowFilter } from "../lib/playlist-filter";
import { usePlaylistsApi } from "./playlists-context";
import styles from "./TrackContextMenu.module.css";

/** What a right-clicked set of tracks can do: land in a playlist, or make one. */
export function TrackContextMenu({
  at,
  tracks,
  onClose,
}: {
  at: Point | null;
  tracks: PlaylistTrack[];
  onClose: () => void;
}) {
  const { playlists, addTracks, createWithTracks } = usePlaylistsApi();
  const [query, setQuery] = useState("");
  const [openedAt, setOpenedAt] = useState(at);

  // The menu stays mounted across open and close, so last time's query would
  // otherwise still be narrowing the list when it reopens. Resetting during
  // render rather than in an effect keeps the stale list from painting once.
  if (at !== openedAt) {
    setOpenedAt(at);
    if (at !== null) setQuery("");
  }

  // A linked playlist someone else owns has nowhere to put the tracks: the
  // write would go to Spotify and be refused. Leave it out rather than offer
  // an action that cannot work.
  const addable = playlists.filter(canAddTracks);
  const filtering = shouldShowFilter(addable.length);
  const matches = filterPlaylists(addable, query);

  return (
    <ContextMenu at={at} onClose={onClose}>
      {filtering && (
        <input
          className={styles.filter}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Enter means "take the top match". With none, it must not fall
          // through to the menu's handler and click "New playlist".
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches.length === 0) event.stopPropagation();
          }}
          placeholder="Filter playlists"
          aria-label="Filter playlists"
        />
      )}
      {matches.map((playlist) => (
        <ContextMenuItem
          key={playlist.id}
          onSelect={() => addTracks(playlist.id, tracks)}
        >
          Add to “{playlist.name}”
        </ContextMenuItem>
      ))}
      <ContextMenuItem
        onSelect={() => createWithTracks(defaultPlaylistName(playlists.map((p) => p.name)), tracks)}
        /* Named against every playlist, not just the addable ones, so a new
           playlist never takes a name already on screen. */
      >
        New playlist
      </ContextMenuItem>
    </ContextMenu>
  );
}
