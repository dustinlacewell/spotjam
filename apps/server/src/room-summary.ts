// Room summary — the one-line view of a room, and when it changed.
//
// Pure. `summarize` is the only place a RoomState becomes a RoomSummary, and
// `sameSummary` is what lets the shell skip a push: a room commits on every
// progress tick, and none of those ticks change a line in a room browser.

import type { RoomSummary } from "@spotjam/protocol";

import type { RoomState } from "./room-state.ts";

/** A room as a browser lists it. */
export function summarize(state: RoomState): RoomSummary {
  return {
    roomId: state.roomId,
    listeners: state.members.size,
    trackUri: state.pointer.uri,
    createdAtEpochMs: state.createdAtEpochMs,
  };
}

/** Field-wise equality. Two equal summaries render the same row. */
export function sameSummary(a: RoomSummary, b: RoomSummary): boolean {
  return (
    a.roomId === b.roomId &&
    a.listeners === b.listeners &&
    a.trackUri === b.trackUri &&
    a.createdAtEpochMs === b.createdAtEpochMs
  );
}
