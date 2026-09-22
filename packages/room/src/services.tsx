// The two things the room UI needs from its shell. The `Room` itself stays an
// explicit prop; these two are needed deep inside the tree by components that
// would otherwise thread them through every layer, so they travel by context.

import { createContext, useContext } from "react";
import type { ListService } from "./ports/list-service";
import type { PlaylistService } from "./ports/playlist-service";
import type { TrackMetadataSource } from "./ports/track-metadata";

/**
 * How the local player stands relative to the room.
 *
 * - `attached`: this shell drives the local Spotify player.
 * - `detached`: the user took the player back. Everything but playback goes on.
 * - `no-spotify`: there is no client to drive. Not a state the user chose, so
 *   not one they can act on.
 */
export type PlayerControlState = "attached" | "detached" | "no-spotify";

/** Reading the local player's control state, and handing it over either way. */
export interface PlayerControl {
  subscribe(listener: (state: PlayerControlState) => void): () => void;
  attach(): void;
  detach(): void;
}

export interface RoomServices {
  trackMetadata: TrackMetadataSource;
  playlistService: PlaylistService;
  /**
   * Resolves album and artist links into static track lists. Optional because
   * only a shell that drives the signed-in Spotify client can answer it; a
   * web shell surfaces album and artist links as unresolvable instead.
   */
  listService?: ListService;
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
