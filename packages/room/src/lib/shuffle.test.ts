import { describe, expect, it } from "vitest";
import { shuffled } from "./shuffle";

describe("shuffled", () => {
  it("returns a new array and leaves the input untouched", () => {
    const before = [1, 2, 3];
    const next = shuffled(before);
    expect(next).not.toBe(before);
    expect(before).toEqual([1, 2, 3]);
  });

  it("keeps every element, duplicates included", () => {
    const next = shuffled([1, 1, 2, 3]);
    expect([...next].sort()).toEqual([1, 1, 2, 3]);
  });

  it("permutes deterministically when randomness is pinned", () => {
    // random() === 0 swaps each tail element into slot 0 in turn.
    expect(shuffled([1, 2, 3], () => 0)).toEqual([2, 3, 1]);
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled([7])).toEqual([7]);
  });
});
