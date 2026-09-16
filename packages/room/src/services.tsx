// The two things the room UI needs from its shell. The `Room` itself stays an
// explicit prop; these two are needed deep inside the tree by components that
// would otherwise thread them through every layer, so they travel by context.

import { createContext, useContext } from "react";
import type { PlaylistService } from "./ports/playlist-service";
import type { TrackMetadataSource } from "./ports/track-metadata";

/**
 * How the local player stands relative to the room.
 *
 * - `idle`: the room names no track, so there is nothing to drive.
 * - `following`: this shell drives the local player.
 * - `detached`: the user took the player back. Everything but playback goes on.
 */
export type PlayerControlState = "idle" | "following" | "detached";

/** Reading the local player's control state, and taking it back. */
export interface PlayerControl {
  subscribe(listener: (control: PlayerControlState) => void): () => void;
  attach(): void;
}

export interface RoomServices {
  trackMetadata: TrackMetadataSource;
  playlistService: PlaylistService;
  /** How the local player is driven, if this shell drives one at all. Web shells pass nothing. */
  playerControl?: PlayerControl;
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
