import { describe, expect, it } from "vitest";
import { FILTER_THRESHOLD, filterPlaylists, shouldShowFilter } from "./playlist-filter";

const NAMED = [
  { id: "1", name: "Morning Coffee" },
  { id: "2", name: "evening walk" },
  { id: "3", name: "Deep Focus" },
  { id: "4", name: "MORNING RUN" },
];

describe("filterPlaylists", () => {
  it("returns every playlist for an empty query", () => {
    expect(filterPlaylists(NAMED, "")).toEqual(NAMED);
  });

  it("matches without regard to case", () => {
    expect(filterPlaylists(NAMED, "morning").map((p) => p.id)).toEqual(["1", "4"]);
  });

  it("matches a substring, not only a prefix", () => {
    expect(filterPlaylists(NAMED, "walk").map((p) => p.id)).toEqual(["2"]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterPlaylists(NAMED, "  focus  ").map((p) => p.id)).toEqual(["3"]);
    // Trimming to nothing is not a filter either.
    expect(filterPlaylists(NAMED, "   ")).toEqual(NAMED);
  });

  it("returns nothing when no name matches", () => {
    expect(filterPlaylists(NAMED, "zzz")).toEqual([]);
  });

  it("preserves input order", () => {
    const names = filterPlaylists(NAMED, "n").map((p) => p.name);
    expect(names).toEqual(["Morning Coffee", "evening walk", "MORNING RUN"]);
  });

  it("does not mutate its input", () => {
    const before = [...NAMED];
    filterPlaylists(NAMED, "morning");
    expect(NAMED).toEqual(before);
  });

  it("returns a fresh array for an empty query", () => {
    expect(filterPlaylists(NAMED, "")).not.toBe(NAMED);
  });

  it("handles an empty playlist list", () => {
    expect(filterPlaylists([], "anything")).toEqual([]);
  });
});

describe("shouldShowFilter", () => {
  it("stays hidden at or below the threshold", () => {
    expect(shouldShowFilter(0)).toBe(false);
    expect(shouldShowFilter(1)).toBe(false);
    expect(shouldShowFilter(FILTER_THRESHOLD)).toBe(false);
    expect(shouldShowFilter(5)).toBe(false);
  });

  it("appears one past the threshold", () => {
    expect(shouldShowFilter(6)).toBe(true);
  });
});
