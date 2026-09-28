import { useState } from "react";
import { ContextMenuItem, type Point } from "@spotjam/ui";
import type { PlaylistTrack } from "@spotjam/protocol";
import { canAddTracks, defaultPlaylistName, rowsOfTracks } from "../../lib/playlists";
import { filterPlaylists, shouldShowFilter } from "../../lib/playlist-filter";
import { usePlaylistsApi } from "../playlists-context";
import styles from "./PlaylistItems.module.css";

/** The playlists the right-clicked tracks can land in, and a new one. */
export function PlaylistItems({
  at,
  tracks,
}: {
  at: Point;
  tracks: PlaylistTrack[];
}) {
  const { playlists, addTracks, createWithTracks } = usePlaylistsApi();
  const [query, setQuery] = useState("");
  const [openedAt, setOpenedAt] = useState(at);

  // A right-click on another row while the menu is up moves it without a
  // close in between, so this stays mounted and the last query would still
  // narrow the list. Resetting during render rather than in an effect keeps
  // the stale list from painting once.
  if (at !== openedAt) {
    setOpenedAt(at);
    setQuery("");
  }

  // A linked playlist someone else owns has nowhere to put the tracks: the
  // write would go to Spotify and be refused. Leave it out rather than offer
  // an action that cannot work.
  const addable = playlists.filter(canAddTracks);
  const filtering = shouldShowFilter(addable.length);
  const matches = filterPlaylists(addable, query);

  return (
    <>
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
        /* A brand-new playlist is local, so its rows carry no Spotify identity. */
        onSelect={() =>
          createWithTracks(
            defaultPlaylistName(playlists.map((p) => p.name)),
            rowsOfTracks(tracks),
          )
        }
        /* Named against every playlist, not just the addable ones, so a new
           playlist never takes a name already on screen. */
      >
        New playlist
      </ContextMenuItem>
    </>
  );
}
