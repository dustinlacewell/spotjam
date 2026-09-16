import { describe, expect, it } from "vitest";
import { NULL_POINTER, type PlaybackPointer, type SessionEntry } from "@spotjam/protocol";
import { desiredAt } from "./desired";

function entry(id: string, durationMs = 200_000): SessionEntry {
  return {
    item: { id, uri: `spotify:track:${id}`, trackId: id, durationMs },
    ownerPubkey: "aa",
    ownerName: "someone",
  };
}

function pointer(over: Partial<PlaybackPointer> = {}): PlaybackPointer {
  return {
    itemId: "one",
    ownerPubkey: "aa",
    uri: "spotify:track:one",
    startedAtEpochMs: 1_000_000,
    isPaused: false,
    pausedAtOffsetMs: 0,
    durationMs: 200_000,
    ...over,
  };
}

describe("desiredAt", () => {
  it("is idle on an empty pointer", () => {
    expect(desiredAt(NULL_POINTER, [], 1_000_000)).toEqual({ kind: "idle" });
  });

  it("plays the pointer track at the clock's position", () => {
    expect(desiredAt(pointer(), [], 1_030_000)).toEqual({
      kind: "play",
      uri: "spotify:track:one",
      positionMs: 30_000,
      durationMs: 200_000,
      paused: false,
      nextUri: null,
    });
  });

  it("puts the session head in the queue slot while the pointer stands", () => {
    const desired = desiredAt(pointer(), [entry("two"), entry("three")], 1_030_000);
    expect(desired).toMatchObject({ uri: "spotify:track:one", nextUri: "spotify:track:two" });
  });

  it("holds the frozen offset while paused", () => {
    const desired = desiredAt(pointer({ isPaused: true, pausedAtOffsetMs: 12_000 }), [], 9_999_999);
    expect(desired).toMatchObject({ positionMs: 12_000, paused: true });
  });

  it("settles one step past the end onto the session head", () => {
    // The pointer's track ends at 1_200_000; the clock is 5s past that.
    const desired = desiredAt(pointer(), [entry("two"), entry("three")], 1_205_000);
    expect(desired).toEqual({
      kind: "play",
      uri: "spotify:track:two",
      // startedAt is the old end, so the overshoot is not lost.
      positionMs: 5000,
      // The settled pointer carries the *new* track's length.
      durationMs: 200_000,
      paused: false,
      // The head was consumed by the settle: the slot holds the one behind it.
      nextUri: "spotify:track:three",
    });
  });

  it("empties the queue slot when the settle consumed the only entry", () => {
    const desired = desiredAt(pointer(), [entry("two")], 1_205_000);
    expect(desired).toMatchObject({ uri: "spotify:track:two", nextUri: null });
  });

  it("goes idle when the track ended and nothing follows", () => {
    expect(desiredAt(pointer(), [], 1_205_000)).toEqual({ kind: "idle" });
  });

  it("does not settle a paused pointer, however long it sits", () => {
    const desired = desiredAt(
      pointer({ isPaused: true, pausedAtOffsetMs: 199_000 }),
      [entry("two")],
      9_999_999,
    );
    expect(desired).toMatchObject({ uri: "spotify:track:one", nextUri: "spotify:track:two" });
  });

  it("clamps the position to the track length", () => {
    // One tick before the end, with nothing queued, the clock cannot run past it.
    const desired = desiredAt(pointer(), [], 1_199_999);
    expect(desired).toMatchObject({ positionMs: 199_999 });
  });
});
