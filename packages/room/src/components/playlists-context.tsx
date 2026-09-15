// The playlists api reaches row-level menus buried in every track list, so it
// travels by context rather than through every list's props.

import { createContext, useContext } from "react";
import type { PlaylistsApi } from "./use-playlists";

const PlaylistsContext = createContext<PlaylistsApi | null>(null);

export function PlaylistsProvider({
  api,
  children,
}: {
  api: PlaylistsApi;
  children: React.ReactNode;
}) {
  return <PlaylistsContext.Provider value={api}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylistsApi(): PlaylistsApi {
  const api = useContext(PlaylistsContext);
  if (api === null) {
    throw new Error("usePlaylistsApi: no <PlaylistsProvider> above this component.");
  }
  return api;
}
