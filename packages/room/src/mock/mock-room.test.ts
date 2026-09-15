import { describe, expect, it, vi } from "vitest";

import type { QueueItem } from "@spotjam/protocol";

import { describeRoomContract, type RoomHarness } from "../testing";
import { DEFAULT_DURATION_MS, MockRoom, type MockRoomSeed } from "./mock-room";

const ME = "me-pubkey";
const OTHER = "other-pubkey";
const EPOCH = 1_700_000_000_000;

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id };
}

/** A room with two broadcasters, on a clock the test drives by hand. */
function makeHarness(overrides: Partial<MockRoomSeed> = {}): RoomHarness {
  let now = EPOCH;
  const room = new MockRoom({
    myPubkey: ME,
    clock: () => now,
    participants: [
      {
        pubkey: ME,
        username: "me",
        broadcasting: true,
        queue: [track("m1"), track("m2")],
      },
      {
        pubkey: OTHER,
        username: "other",
        broadcasting: true,
        queue: [track("o1"), track("o2")],
      },
    ],
    ...overrides,
  });

  return {
    room,
    me: ME,
    other: OTHER,
    advanceClock: (ms) => {
      now += ms;
    },
    destroy: () => room.destroy(),
  };
}

describeRoomContract("MockRoom", () => makeHarness());

describe("MockRoom seeding", () => {
  it("plays the head of the session queue when `playing` is omitted", () => {
    const { room } = makeHarness();

    // Seed order fixes the rotation, so my first track leads.
    expect(room.getPlaybackPointer().itemId).toBe("m1");
    expect(room.getPlaybackPointer().ownerPubkey).toBe(ME);
    // The playing track leaves its owner's queue, as the server has it.
    expect(room.myQueue().map((item) => item.id)).toEqual(["m2"]);
  });

  it("plays nothing when `playing` is null", () => {
    const { room } = makeHarness({ playing: null });

    expect(room.getPlaybackPointer().itemId).toBeNull();
    expect(room.myProgress()).toBeNull();
    // No track was consumed, so both queues are whole.
    expect(room.myQueue().map((item) => item.id)).toEqual(["m1", "m2"]);
  });

  it("advances to a named item, consuming what came before it", () => {
    const { room } = makeHarness({
      playing: { itemId: "o1", durationMs: 180_000, positionMs: 30_000 },
    });

    expect(room.getPlaybackPointer().itemId).toBe("o1");
    expect(room.myProgress()).toEqual({
      itemId: "o1",
      positionMs: 30_000,
      durationMs: 180_000,
      sampledAtEpochMs: EPOCH,
    });
    // Reaching o1 meant playing m1 first, so it is gone from my queue.
    expect(room.myQueue().map((item) => item.id)).toEqual(["m2"]);
  });

  it("seeds a paused pointer that does not move with the clock", () => {
    const harness = makeHarness({
      playing: { itemId: "m1", durationMs: 200_000, positionMs: 12_000, paused: true },
    });

    expect(harness.room.getPlaybackPointer().isPaused).toBe(true);
    harness.advanceClock(9_000);
    expect(harness.room.myProgress()?.positionMs).toBe(12_000);
  });

  it("gives an item that becomes current later the default duration", () => {
    const { room } = makeHarness({ playing: { itemId: "m1", durationMs: 100_000 } });

    room.skip();
    expect(room.myProgress()?.durationMs).toBe(DEFAULT_DURATION_MS);
  });

  it("takes a later item's length from the `durations` seed", () => {
    const { room } = makeHarness({
      playing: { itemId: "m1", durationMs: 100_000 },
      durations: { o1: 123_000 },
    });

    room.skip();
    expect(room.getPlaybackPointer().itemId).toBe("o1");
    expect(room.myProgress()?.durationMs).toBe(123_000);
  });

  it("clamps progress to the track's length", () => {
    const harness = makeHarness({ playing: { itemId: "m1", durationMs: 10_000 } });

    harness.advanceClock(60_000);
    expect(harness.room.myProgress()?.positionMs).toBe(10_000);
  });
});

describe("MockRoom playback rules", () => {
  it("skips around the rotation, one track from each broadcaster", () => {
    const { room } = makeHarness();

    expect(room.getPlaybackPointer().itemId).toBe("m1");
    room.skip();
    expect(room.getPlaybackPointer().itemId).toBe("o1");
    room.skip();
    expect(room.getPlaybackPointer().itemId).toBe("m2");
    room.skip();
    expect(room.getPlaybackPointer().itemId).toBe("o2");
  });

  it("clears the pointer once every broadcaster has run out", () => {
    const { room } = makeHarness();

    for (let i = 0; i < 4; i++) room.skip();
    expect(room.getPlaybackPointer().itemId).toBeNull();
    expect(room.myProgress()).toBeNull();
  });

  it("interleaves the session queue across broadcasters", () => {
    const { room } = makeHarness({ playing: null });

    expect(room.sessionQueue().map((entry) => entry.item.id)).toEqual([
      "m1",
      "o1",
      "m2",
      "o2",
    ]);
  });

  it("leaves a non-broadcaster out of the session queue", () => {
    const { room } = makeHarness({ playing: null });

    // Stopping leaves one broadcaster, which the room then starts playing:
    // o1 goes onto the pointer, so only o2 is still queued.
    room.setBroadcasting(false);
    expect(room.getPlaybackPointer().itemId).toBe("o1");
    expect(room.sessionQueue().map((entry) => entry.item.id)).toEqual(["o2"]);
  });

  it("clears the pointer when the last broadcaster stops", () => {
    const room = new MockRoom({
      myPubkey: ME,
      clock: () => EPOCH,
      participants: [
        { pubkey: ME, username: "me", broadcasting: true, queue: [track("m1")] },
        { pubkey: OTHER, username: "other", broadcasting: false, queue: [] },
      ],
    });

    expect(room.getPlaybackPointer().itemId).toBe("m1");
    room.setBroadcasting(false);
    expect(room.getPlaybackPointer().itemId).toBeNull();
    room.destroy();
  });

  it("starts playing when a broadcaster's first track arrives", () => {
    const room = new MockRoom({
      myPubkey: ME,
      clock: () => EPOCH,
      participants: [{ pubkey: ME, username: "me", broadcasting: true, queue: [] }],
    });

    expect(room.getPlaybackPointer().itemId).toBeNull();
    room.appendToMyQueue([track("m1")]);
    expect(room.getPlaybackPointer().itemId).toBe("m1");
    room.destroy();
  });

  it("uses the injected rng for shuffle, so an order can be pinned", () => {
    const room = new MockRoom({
      myPubkey: ME,
      playing: null,
      rng: () => 0,
      participants: [
        {
          pubkey: ME,
          username: "me",
          broadcasting: false,
          queue: [track("a"), track("b"), track("c")],
        },
      ],
    });

    // Fisher-Yates with rng() === 0 swaps each tail entry with the head.
    room.shuffleMyQueue();
    expect(room.myQueue().map((item) => item.id)).toEqual(["b", "c", "a"]);
    room.destroy();
  });
});

describe("MockRoom teardown", () => {
  it("stops notifying listeners after destroy", () => {
    const { room } = makeHarness();
    const changes = vi.fn();
    room.onChange(changes);

    room.appendToMyQueue([track("x")]);
    expect(changes).toHaveBeenCalledTimes(1);

    room.destroy();
    room.appendToMyQueue([track("y")]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("drops status listeners too", () => {
    const { room } = makeHarness();
    const statuses = vi.fn();
    room.onStatus(statuses);
    expect(statuses).toHaveBeenCalledTimes(1);

    room.destroy();
    room.onStatus(statuses);
    // A fresh subscribe still answers; destroy only forgets what it held.
    expect(statuses).toHaveBeenCalledTimes(2);
  });
});
