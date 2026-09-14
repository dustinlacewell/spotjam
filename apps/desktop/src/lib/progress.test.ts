import { describe, expect, it } from "vitest";
import { displayedProgress, formatClock } from "./progress";
import type { PlaybackPointer, Progress } from "./room";

const EPOCH = 1_700_000_000_000;

function pointer(overrides: Partial<PlaybackPointer> = {}): PlaybackPointer {
  return {
    itemId: "i1",
    ownerPubkey: "aa".repeat(32),
    uri: "spotify:track:x",
    startedAtEpochMs: EPOCH,
    isPaused: false,
    pausedAtOffsetMs: 0,
    ...overrides,
  };
}

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    itemId: "i1",
    positionMs: 10_000,
    durationMs: 200_000,
    sampledAtEpochMs: EPOCH,
    ...overrides,
  };
}

describe("displayedProgress", () => {
  it("extrapolates a playing sample forward to now", () => {
    expect(displayedProgress(pointer(), progress(), EPOCH + 3000)).toEqual({
      positionMs: 13_000,
      durationMs: 200_000,
    });
  });

  it("reads the frozen pointer offset while paused", () => {
    const paused = pointer({ isPaused: true, pausedAtOffsetMs: 45_000 });
    // The sample is stale; the pause offset wins.
    expect(displayedProgress(paused, progress(), EPOCH + 60_000)).toEqual({
      positionMs: 45_000,
      durationMs: 200_000,
    });
  });

  it("clamps past the end of the track", () => {
    const sample = progress({ positionMs: 199_000, durationMs: 200_000 });
    expect(displayedProgress(pointer(), sample, EPOCH + 30_000)?.positionMs).toBe(200_000);
  });

  it("clamps below zero", () => {
    const paused = pointer({ isPaused: true, pausedAtOffsetMs: -500 });
    expect(displayedProgress(paused, progress(), EPOCH)?.positionMs).toBe(0);
  });

  it("is null when the pointer names no item", () => {
    expect(displayedProgress(pointer({ itemId: null }), progress(), EPOCH)).toBeNull();
  });

  it("is null without a sample", () => {
    expect(displayedProgress(pointer(), null, EPOCH)).toBeNull();
  });

  it("is null when the sample is for another item", () => {
    expect(displayedProgress(pointer(), progress({ itemId: "i2" }), EPOCH)).toBeNull();
  });
});

describe("formatClock", () => {
  it("floors to whole seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
    expect(formatClock(1000)).toBe("0:01");
    expect(formatClock(61_999)).toBe("1:01");
  });

  it("pads seconds to two digits", () => {
    expect(formatClock(605_000)).toBe("10:05");
  });

  it("reads negative as zero", () => {
    expect(formatClock(-5000)).toBe("0:00");
  });
});
