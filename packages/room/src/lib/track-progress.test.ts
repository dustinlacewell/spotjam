import { describe, expect, it } from "vitest";
import { formatClock, trackProgressView, PLACEHOLDER_CLOCK } from "./track-progress";

describe("trackProgressView", () => {
  it("shows both clocks and a seekable bar when the length is known", () => {
    expect(trackProgressView(30_000, 200_000)).toEqual({
      elapsedText: "0:30",
      trailingText: "3:20",
      fraction: 0.15,
      seekable: true,
      indeterminate: false,
    });
  });

  // The reported bug: a real track played and the elapsed clock read "-:--".
  it("ticks the elapsed clock but hides the length when it is unknown", () => {
    // A bar with a position inside an unknown length would be a lie.
    expect(trackProgressView(30_000, 0)).toEqual({
      elapsedText: "0:30",
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: true,
    });
  });

  it("shows placeholders and an inert bar when nothing plays", () => {
    expect(trackProgressView(null, 0)).toEqual({
      elapsedText: PLACEHOLDER_CLOCK,
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
      indeterminate: false,
    });
  });

  it("treats a negative length as unknown rather than a track of negative length", () => {
    expect(trackProgressView(5_000, -1)).toMatchObject({
      trailingText: PLACEHOLDER_CLOCK,
      fraction: 0,
      seekable: false,
    });
  });

  it("caps the fraction at a full bar", () => {
    // positionAt clamps, but a pointer duration that shrank under a stale
    // position must still not overfill the bar.
    expect(trackProgressView(300_000, 200_000).fraction).toBe(1);
  });

  it("never draws a negative fill", () => {
    expect(trackProgressView(-5_000, 200_000).fraction).toBe(0);
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
