import { describe, expect, it } from "vitest";
import { NULL_POINTER, type PlaybackPointer, type SessionEntry } from "./events.js";
import { endsAt, positionAt, settleOnce } from "./pointer.js";

const OWNER = "a".repeat(64);

function playing(startedAtEpochMs: number, durationMs: number): PlaybackPointer {
  return {
    itemId: "item-1",
    ownerPubkey: OWNER,
    uri: "spotify:track:one",
    startedAtEpochMs,
    isPaused: false,
    pausedAtOffsetMs: 0,
    durationMs,
  };
}

function paused(pausedAtOffsetMs: number, durationMs: number): PlaybackPointer {
  return { ...playing(0, durationMs), isPaused: true, pausedAtOffsetMs };
}

const nextEntry: SessionEntry = {
  item: { id: "item-2", uri: "spotify:track:two", trackId: "two", durationMs: 90_000 },
  ownerPubkey: OWNER,
  ownerName: "dustin",
};

describe("positionAt", () => {
  it("is 0 for an empty pointer", () => {
    expect(positionAt(NULL_POINTER, 5_000)).toBe(0);
  });

  it("reads the frozen offset while paused", () => {
    expect(positionAt(paused(12_000, 60_000), 999_999)).toBe(12_000);
  });

  it("counts from the start while playing", () => {
    expect(positionAt(playing(1_000, 60_000), 31_000)).toBe(30_000);
  });

  it("clamps to 0 before the start", () => {
    expect(positionAt(playing(10_000, 60_000), 4_000)).toBe(0);
  });

  it("clamps at the duration once past the end", () => {
    expect(positionAt(playing(0, 60_000), 200_000)).toBe(60_000);
  });
});

describe("endsAt", () => {
  it("is null for an empty pointer", () => {
    expect(endsAt(NULL_POINTER)).toBeNull();
  });

  it("is null while paused", () => {
    expect(endsAt(paused(5_000, 60_000))).toBeNull();
  });

  it("is start plus duration while playing", () => {
    expect(endsAt(playing(1_000, 60_000))).toBe(61_000);
  });
});

describe("settleOnce", () => {
  it("leaves an empty pointer alone", () => {
    expect(settleOnce(NULL_POINTER, nextEntry, 10_000)).toBe(NULL_POINTER);
  });

  it("leaves a paused pointer alone", () => {
    const p = paused(5_000, 60_000);
    expect(settleOnce(p, nextEntry, 10_000_000)).toBe(p);
  });

  it("leaves a playing pointer alone before the end", () => {
    const p = playing(0, 60_000);
    expect(settleOnce(p, nextEntry, 59_999)).toBe(p);
  });

  it("advances exactly at the end", () => {
    const p = playing(0, 60_000);
    expect(settleOnce(p, nextEntry, 60_000).itemId).toBe("item-2");
  });

  it("starts the next track at the old end, not at now", () => {
    const settled = settleOnce(playing(1_000, 60_000), nextEntry, 200_000);
    expect(settled).toEqual({
      itemId: "item-2",
      ownerPubkey: OWNER,
      uri: "spotify:track:two",
      startedAtEpochMs: 61_000,
      isPaused: false,
      pausedAtOffsetMs: 0,
      durationMs: 90_000,
    });
  });

  it("empties the pointer past the end with nothing next", () => {
    expect(settleOnce(playing(0, 60_000), null, 200_000)).toEqual(NULL_POINTER);
  });
});
