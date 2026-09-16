import { describe, expect, it } from "vitest";

import { OFFSET_ALPHA, foldOffset, serverNow } from "./clock-offset";

describe("foldOffset", () => {
  it("takes the first sample whole", () => {
    expect(foldOffset(null, 1_000, 400)).toBe(600);
  });

  it("takes a negative first sample whole", () => {
    expect(foldOffset(null, 400, 1_000)).toBe(-600);
  });

  it("blends a later sample by the EMA alpha", () => {
    // prev 600, sample 700 -> 600 + 0.2 * 100
    expect(foldOffset(600, 1_700, 1_000)).toBeCloseTo(620, 9);
  });

  it("leaves the offset alone when the sample agrees", () => {
    expect(foldOffset(600, 1_600, 1_000)).toBe(600);
  });

  it("converges toward a steady sample", () => {
    let offset = foldOffset(null, 1_000, 1_000);
    for (let i = 0; i < 100; i++) offset = foldOffset(offset, 5_000, 1_000);
    expect(offset).toBeCloseTo(4_000, 3);
  });

  it("moves one alpha-step per sample, so one late frame cannot take over", () => {
    const offset = foldOffset(0, 10_000, 0);
    expect(offset).toBe(10_000 * OFFSET_ALPHA);
  });
});

describe("serverNow", () => {
  it("shifts local time into the server's frame", () => {
    expect(serverNow(600, 1_000)).toBe(1_600);
  });

  it("handles a server clock behind ours", () => {
    expect(serverNow(-600, 1_000)).toBe(400);
  });
});
