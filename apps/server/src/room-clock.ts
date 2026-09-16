// Room clock — the timer that ends a track when nobody is there to say so.
//
// Playback advances on the server's own clock: no client reports a track end,
// and no client is trusted to. This holds at most one pending timer per room,
// set for the instant the pointed track runs out. When it fires, the room is
// settled, committed, and published — the same path an op takes, so members
// cannot tell a track change from a skip.
//
// Everything volatile arrives injected: the clock, and the timer functions
// themselves. A test drives real behaviour with fakes and no waiting.

import { endsAt } from "@spotjam/protocol";

import type { Clock } from "./ports.ts";
import * as Room from "./room-state.ts";
import type { RoomRegistry } from "./rooms.ts";

/** A pending timer, as the host hands it back. Opaque to this module. */
export type TimerHandle = unknown;

/** The timer pair, shaped like the globals so production is a straight pass. */
export interface Timers {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface RoomClockDeps {
  rooms: RoomRegistry;
  clock: Clock;
  timers: Timers;
  /** Tell everyone who cares that this room moved. The Session's own publish. */
  publish(roomId: string): void;
}

/** Node's timers, wrapped to the injected shape. */
export const nodeTimers: Timers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RoomClock {
  readonly #deps: RoomClockDeps;
  readonly #pending = new Map<string, TimerHandle>();

  constructor(deps: RoomClockDeps) {
    this.#deps = deps;
  }

  /**
   * Point the room's timer at its current track end.
   *
   * Called after every commit, so the timer always describes the state that is
   * actually stored: a pause, a skip, a seek, or a deserted room each replace
   * or drop the earlier timer rather than leaving it to fire on stale facts.
   */
  arm(roomId: string): void {
    this.cancel(roomId);

    const { rooms, clock, timers } = this.#deps;
    if (!rooms.has(roomId)) return;

    const end = endsAt(rooms.get(roomId).pointer);
    if (end === null) return;

    // A boundary already behind us still fires, on the next tick rather than
    // never: a settle that lands exactly on an end leaves the next track due
    // immediately, and a negative delay is how a host spells "as soon as you can".
    const handle = timers.set(() => this.#fire(roomId), Math.max(0, end - clock.now()));
    this.#pending.set(roomId, handle);
  }

  /** Forget this room's timer. Safe for a room that has none. */
  cancel(roomId: string): void {
    const handle = this.#pending.get(roomId);
    if (handle === undefined) return;
    this.#deps.timers.clear(handle);
    this.#pending.delete(roomId);
  }

  /** Drop every timer. For shutdown. */
  cancelAll(): void {
    for (const roomId of [...this.#pending.keys()]) this.cancel(roomId);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * The track ran out: catch the room up, store it, tell the room.
   *
   * Publishing re-arms, because the Session arms on every publish — so a queue
   * of short tracks keeps stepping without this method knowing about the next one.
   */
  #fire(roomId: string): void {
    this.#pending.delete(roomId);

    const { rooms, clock, publish } = this.#deps;
    if (!rooms.has(roomId)) return;

    rooms.commit(Room.settle(rooms.get(roomId), clock.now()));
    publish(roomId);
  }
}
