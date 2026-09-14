import { describe, expect, it } from "vitest";
import {
  NULL_POINTER,
  pausedPointer,
  positionMs,
  resumedPointer,
  seekedPointer,
  startedPointer,
} from "./playback-clock";
import type { PlaybackPointer, SessionEntry } from "./room";

const entry: SessionEntry = {
  item: { id: "i1", uri: "spotify:track:x", trackId: "x", addedBy: "alice" },
  ownerId: "a",
  ownerName: "alice",
};

const playing: PlaybackPointer = {
  itemId: "i1",
  ownerId: "a",
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

describe("pause and resume", () => {
  it("freezes the current position on pause", () => {
    const paused = pausedPointer(playing, 1_045_000);
    expect(paused.isPaused).toBe(true);
    expect(paused.pausedAtOffsetMs).toBe(45_000);
  });

  it("preserves position across a pause and a later resume", () => {
    const paused = pausedPointer(playing, 1_045_000);
    const resumed = resumedPointer(paused, 2_000_000);
    expect(resumed.isPaused).toBe(false);
    expect(positionMs(resumed, 2_000_000)).toBe(45_000);
    expect(positionMs(resumed, 2_005_000)).toBe(50_000);
  });

  it("leaves the pointer alone when already in the requested state", () => {
    expect(pausedPointer(pausedPointer(playing, 1_045_000), 9_000_000).pausedAtOffsetMs).toBe(
      45_000,
    );
    expect(resumedPointer(playing, 5_000_000)).toBe(playing);
  });
});

describe("seekedPointer", () => {
  it("moves the clock origin so the new position reads now", () => {
    const seeked = seekedPointer(playing, 90_000, 1_020_000);
    expect(seeked.isPaused).toBe(false);
    expect(positionMs(seeked, 1_020_000)).toBe(90_000);
    expect(positionMs(seeked, 1_025_000)).toBe(95_000);
  });

  it("moves the frozen offset while paused, and keeps it frozen", () => {
    const paused = { ...playing, isPaused: true, pausedAtOffsetMs: 12_000 };
    const seeked = seekedPointer(paused, 90_000, 1_020_000);
    expect(seeked.isPaused).toBe(true);
    expect(seeked.pausedAtOffsetMs).toBe(90_000);
    expect(positionMs(seeked, 9_999_999)).toBe(90_000);
  });

  it("clamps a negative target to the top of the track", () => {
    expect(positionMs(seekedPointer(playing, -5000, 1_020_000), 1_020_000)).toBe(0);
    expect(seekedPointer({ ...playing, isPaused: true }, -5000, 1_020_000).pausedAtOffsetMs).toBe(0);
  });

  it("leaves an empty pointer alone", () => {
    expect(seekedPointer(NULL_POINTER, 90_000, 1_020_000)).toBe(NULL_POINTER);
  });
});

describe("startedPointer", () => {
  it("points at the entry, playing from the top, now", () => {
    expect(startedPointer(entry, 1_500_000)).toEqual({
      itemId: "i1",
      ownerId: "a",
      uri: "spotify:track:x",
      startedAtEpochMs: 1_500_000,
      isPaused: false,
      pausedAtOffsetMs: 0,
    });
  });
});
