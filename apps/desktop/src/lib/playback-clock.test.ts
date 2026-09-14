import { describe, expect, it } from "vitest";
import { NULL_POINTER, positionMs } from "./playback-clock";
import type { PlaybackPointer } from "./room";

const OWNER = "aa".repeat(32);

const playing: PlaybackPointer = {
  itemId: "i1",
  ownerPubkey: OWNER,
  uri: "spotify:track:x",
  startedAtEpochMs: 1_000_000,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

describe("positionMs", () => {
  it("is zero when nothing is playing", () => {
    expect(positionMs(NULL_POINTER, 1_234_567)).toBe(0);
  });

  it("counts elapsed time while playing", () => {
    expect(positionMs(playing, 1_030_000)).toBe(30_000);
  });

  it("never goes negative when a peer's clock runs behind", () => {
    expect(positionMs(playing, 999_000)).toBe(0);
  });

  it("reports the frozen offset while paused", () => {
    const paused = { ...playing, isPaused: true, pausedAtOffsetMs: 12_000 };
    expect(positionMs(paused, 9_999_999)).toBe(12_000);
  });
});
