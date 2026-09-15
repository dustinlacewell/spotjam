// Queries — a signed request that reads server state without touching any room.
//
// An op always names a roomId and requires membership; an auth payload claims
// an identity. A query is the third case: asking the server something that
// needs neither, like which rooms are live right now.
//
// Queries are subscriptions rather than one-shot reads. A room browser says
// "watch" once and the server pushes a fresh answer whenever the answer
// changes, so nothing has to poll. "unwatch" ends the subscription; dropping
// the socket ends it too.

/** Subscribe to the live room list. Answered at once with `room-list`. */
export interface WatchRoomsQuery {
  type: "watch-rooms";
}

/** Stop receiving `room-list` pushes. */
export interface UnwatchRoomsQuery {
  type: "unwatch-rooms";
}

/**
 * Subscribe to one room's snapshots without joining it.
 *
 * A socket watches at most one room, so a second `watch-room` replaces the
 * first. Answered at once with `room-detail`.
 */
export interface WatchRoomQuery {
  type: "watch-room";
  roomId: string;
}

/** Stop receiving `room-detail` pushes for this room. */
export interface UnwatchRoomQuery {
  type: "unwatch-room";
  roomId: string;
}

export type Query =
  | WatchRoomsQuery
  | UnwatchRoomsQuery
  | WatchRoomQuery
  | UnwatchRoomQuery;

const QUERY_TYPES: ReadonlySet<string> = new Set<Query["type"]>([
  "watch-rooms",
  "unwatch-rooms",
  "watch-room",
  "unwatch-room",
]);

/** Structural check only; the session validates a room-scoped query's roomId. */
export function isQuery(value: unknown): value is Query {
  if (typeof value !== "object" || value === null) return false;
  const query = value as Record<string, unknown>;
  return typeof query.type === "string" && QUERY_TYPES.has(query.type);
}
