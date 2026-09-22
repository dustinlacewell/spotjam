import { beforeEach, describe, expect, it } from "vitest";

import { RoomClock } from "./room-clock.ts";
import * as Room from "./room-state.ts";
import { RoomRegistry } from "./rooms.ts";
import { FakeClock, FakeTimers, track } from "./testing.ts";

const ALICE = "a".repeat(64);
const MINUTE = 60_000;

let clock: FakeClock;
let timers: FakeTimers;
let rooms: RoomRegistry;
let published: string[];
let roomClock: RoomClock;

beforeEach(() => {
  clock = new FakeClock();
  timers = new FakeTimers();
  rooms = new RoomRegistry();
  published = [];
  roomClock = new RoomClock({
    rooms,
    clock,
    timers,
    // The Session re-arms on every publish; mirror that here.
    publish: (roomId) => {
      published.push(roomId);
      roomClock.arm(roomId);
    },
  });
});

/** Commit a room where Alice is broadcasting `durations`, playing from now. */
function playing(...durations: number[]): void {
  let state = Room.join(Room.emptyRoom("jam", clock.now()), ALICE, "alice");
  state = Room.setBroadcasting(state, ALICE, true);
  state = Room.enqueue(
    state,
    ALICE,
    durations.map((ms, i) => track(`a${i + 1}`, ms)),
  );
  rooms.commit(Room.advance(state, clock.now()));
}

describe("RoomClock", () => {
  it("arms for the pointed track's end", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");

    expect(timers.pendingCount).toBe(1);
    expect(timers.pendingDelay).toBe(MINUTE);
  });

  it("aims at the remaining time, not the whole track", () => {
    playing(MINUTE);
    clock.advance(20_000);
    roomClock.arm("jam");

    expect(timers.pendingDelay).toBe(40_000);
  });

  it("replaces an earlier timer rather than stacking one", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");
    roomClock.arm("jam");

    expect(timers.pendingCount).toBe(1);
  });

  it("advances the room and publishes when it fires", () => {
    playing(MINUTE, 5 * MINUTE);
    roomClock.arm("jam");

    clock.advance(MINUTE);
    timers.fire();

    expect(rooms.get("jam").pointer).toMatchObject({
      itemId: "a2",
      startedAtEpochMs: clock.now(),
    });
    expect(published).toEqual(["jam"]);
  });

  it("re-arms for the next track", () => {
    playing(MINUTE, 5 * MINUTE);
    roomClock.arm("jam");

    clock.advance(MINUTE);
    timers.fire();

    expect(timers.pendingCount).toBe(1);
    expect(timers.pendingDelay).toBe(5 * MINUTE);
  });

  it("arms nothing once the last track ends", () => {
    playing(MINUTE);
    roomClock.arm("jam");

    clock.advance(MINUTE);
    timers.fire();

    expect(rooms.get("jam").pointer.itemId).toBeNull();
    expect(timers.pendingCount).toBe(0);
  });

  it("arms nothing while the pointer is paused", () => {
    playing(MINUTE, MINUTE);
    rooms.commit(Room.setPaused(rooms.get("jam"), true, clock.now()));
    roomClock.arm("jam");

    expect(timers.pendingCount).toBe(0);
  });

  it("drops a live timer when the room pauses", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");
    expect(timers.pendingCount).toBe(1);

    rooms.commit(Room.setPaused(rooms.get("jam"), true, clock.now()));
    roomClock.arm("jam");

    expect(timers.pendingCount).toBe(0);
  });

  it("arms nothing for a room nobody is playing in", () => {
    rooms.commit(Room.join(Room.emptyRoom("quiet", clock.now()), ALICE, "alice"));
    roomClock.arm("quiet");

    expect(timers.pendingCount).toBe(0);
  });

  it("drops the timer when the room goes deserted", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");

    rooms.commit(Room.leave(rooms.get("jam"), ALICE));
    expect(rooms.has("jam")).toBe(false);
    roomClock.arm("jam");

    expect(timers.pendingCount).toBe(0);
    expect(roomClock.pendingCount).toBe(0);
  });

  it("does nothing when a fire lands on a room that is already gone", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");

    rooms.commit(Room.leave(rooms.get("jam"), ALICE));
    clock.advance(MINUTE);
    timers.fire();

    expect(published).toEqual([]);
  });

  it("cancels every pending timer on shutdown", () => {
    playing(MINUTE, MINUTE);
    roomClock.arm("jam");
    roomClock.cancelAll();

    expect(timers.pendingCount).toBe(0);
    expect(roomClock.pendingCount).toBe(0);
  });

  it("crosses a run of short tracks that all ended while nothing fired", () => {
    // One late timer must not need one fire per missed track.
    playing(1_000, 1_000, 5 * MINUTE);
    roomClock.arm("jam");

    clock.advance(2_500);
    timers.fire();

    expect(rooms.get("jam").pointer.itemId).toBe("a3");
  });
});
