// The two things the room UI needs from its shell. The `Room` itself stays an
// explicit prop; these two are needed deep inside the tree by components that
// would otherwise thread them through every layer, so they travel by context.

import { createContext, useContext } from "react";
import type { PlaylistImporter } from "./ports/playlist-importer";
import type { TrackMetadataSource } from "./ports/track-metadata";

export interface RoomServices {
  trackMetadata: TrackMetadataSource;
  playlistImporter: PlaylistImporter;
}

const RoomServicesContext = createContext<RoomServices | null>(null);

export function RoomServicesProvider({
  services,
  children,
}: {
  services: RoomServices;
  children: React.ReactNode;
}) {
  return (
    <RoomServicesContext.Provider value={services}>{children}</RoomServicesContext.Provider>
  );
}

export function useRoomServices(): RoomServices {
  const services = useContext(RoomServicesContext);
  if (services === null) {
    throw new Error("useRoomServices: no <RoomServicesProvider> above this component.");
  }
  return services;
}
