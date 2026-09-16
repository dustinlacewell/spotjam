import { describe, expect, it } from "vitest";
import { displayedProgress, formatClock, trackProgressView, PLACEHOLDER_CLOCK } from "./progress";
import type { PlaybackPointer, Progress } from "@spotjam/protocol";

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
      kind: "measured",
      positionMs: 13_000,
      durationMs: 200_000,
    });
  });

  it("reads the frozen pointer offset while paused", () => {
    const paused = pointer({ isPaused: true, pausedAtOffsetMs: 45_000 });
    // The sample is stale; the pause offset wins.
    expect(displayedProgress(paused, progress(), EPOCH + 60_000)).toEqual({
      kind: "measured",
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

  // A missing sample is normal: a detached client never reports one, and the
  // broadcaster's first relay has not landed yet. The pointer alone still
  // dates the playback, so the clock ticks -- it just cannot know the length.
  it("counts up from the pointer when there is no sample", () => {
    expect(displayedProgress(pointer(), null, EPOCH + 7000)).toEqual({
      kind: "elapsed-only",
      positionMs: 7000,
    });
  });

  it("counts up from the pointer when the sample is for another item", () => {
    expect(displayedProgress(pointer(), progress({ itemId: "i2" }), EPOCH + 7000)).toEqual({
      kind: "elapsed-only",
      positionMs: 7000,
    });
  });

  it("reads the frozen pointer offset without a sample while paused", () => {
    const paused = pointer({ isPaused: true, pausedAtOffsetMs: 45_000 });
    expect(displayedProgress(paused, null, EPOCH + 60_000)).toEqual({
      kind: "elapsed-only",
      positionMs: 45_000,
    });
  });

  it("never counts below zero without a sample", () => {
    // A pointer dated in the future would otherwise read negative.
    expect(displayedProgress(pointer(), null, EPOCH - 5000)).toEqual({
      kind: "elapsed-only",
      positionMs: 0,
    });
    const paused = pointer({ isPaused: true, pausedAtOffsetMs: -500 });
    expect(displayedProgress(paused, null, EPOCH)).toEqual({
      kind: "elapsed-only",
      positionMs: 0,
    });
  });

  it("does not cap the elapsed count, since no length is known", () => {
    const far = displayedProgress(pointer(), null, EPOCH + 9_999_000);
    expect(far).toEqual({ kind: "elapsed-only", positionMs: 9_999_000 });
  });
});

describe("trackProgressView", () => {
  it("shows both clocks and a seekable bar when the length is known", () => {
    expect(trackProgressView({ kind: "measured", positionMs: 30_000, durationMs: 200_000 })).toEqual({
      elapsedText: "0:30",
      trailingText: "3:20",
      fraction: 0.15,
      seekable: true,
      indeterminate: false,
    });
  });

  // The reported bug: a real track played and the elapsed clock read "-:--".
  it("ticks the elapsed clock but hides the length when it is unknown", () => {
    const view = trackProgressView({ kind: "elapsed-only", positionMs: 30_000 });

    expect(view.elapsedText).toBe("0:30");
    expect(view.trailingText).toBe(PLACEHOLDER_CLOCK);
  });

  it("draws no fill and refuses seeking when the length is unknown", () => {
    // A bar with a position inside an unknown length would be a lie.
    expect(trackProgressView({ kind: "elapsed-only", positionMs: 30_000 })).toMatchObject({
      fraction: 0,
      seekable: false,
      indeterminate: true,
    });
  });

  it("shows placeholders and an inert bar when nothing plays", () => {
    expect(trackProgressView(null)).toEqual({
      elapsedText: PLACEHOLDER_CLOCK,
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: false,
    });
  });

  it("treats a zero length as unknown rather than a zero-length track", () => {
    // Guards the divide: a measured sample can still carry durationMs 0.
    expect(trackProgressView({ kind: "measured", positionMs: 5000, durationMs: 0 })).toMatchObject({
      elapsedText: "0:05",
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: true,
    });
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
