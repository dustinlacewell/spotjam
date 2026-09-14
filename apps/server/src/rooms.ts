// Room registry — the mutable index of live rooms.
//
// The rooms themselves are immutable values; this holds the current one for
// each id and forgets a room the moment its last participant leaves. Keeping a
// deserted room would let stale queues and a stale pointer greet whoever joined
// that id next.

import * as Room from "./room-state.ts";
import type { RoomState } from "./room-state.ts";

export class RoomRegistry {
  readonly #rooms = new Map<string, RoomState>();

  /** The room as it stands, or a fresh empty one. Does not register it. */
  get(roomId: string): RoomState {
    return this.#rooms.get(roomId) ?? Room.emptyRoom(roomId);
  }

  has(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  /** Store the new value, or drop the room when nobody is left in it. */
  commit(state: RoomState): RoomState {
    if (Room.isDeserted(state)) {
      this.#rooms.delete(state.roomId);
    } else {
      this.#rooms.set(state.roomId, state);
    }
    return state;
  }

  get size(): number {
    return this.#rooms.size;
  }

  ids(): string[] {
    return [...this.#rooms.keys()];
  }
}
