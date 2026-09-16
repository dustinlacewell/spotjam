// control — the one state the room UI reads about the local player.
//
// The room does not care whether the bridge is down or merely booting; it cares
// whether there is a player to drive, and whether we are driving it. Two
// sources answer that between them, and this is where they meet.

import type { PlayerControlState } from "@spotjam/room";
import type { BridgeState } from "../bridge-state.js";
import type { Mode } from "./mode.js";

export type { PlayerControlState };

/**
 * No client means no control to speak of, whatever the driver's mode says: a
 * driver attached to a player that is not there has nothing to be attached to,
 * and offering the user a detach button for it would be offering nothing.
 */
export function controlState(bridge: BridgeState | null, mode: Mode): PlayerControlState {
  if (bridge !== "ready") return "no-spotify";
  return mode;
}
