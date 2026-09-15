import { describe, expect, it } from "vitest";
import {
  applySelectionClick,
  emptySelection,
  pruneSelection,
  targetsForContextClick,
  toPlaylistTracks,
  type Selection,
} from "./selection";

const IDS = ["a", "b", "c", "d"];
const PLAIN = { shift: false, toggle: false };
const SHIFT = { shift: true, toggle: false };
const TOGGLE = { shift: false, toggle: true };

function selection(ids: string[], anchorId: string | null): Selection {
  return { ids: new Set(ids), anchorId };
}

describe("applySelectionClick", () => {
  it("selects just the clicked row on a plain click", () => {
    const next = applySelectionClick(selection(["c"], "c"), IDS, "a", PLAIN);
    expect([...next.ids]).toEqual(["a"]);
    expect(next.anchorId).toBe("a");
  });

  it("clears when the clicked row was the only selected one", () => {
    const next = applySelectionClick(selection(["a"], "a"), IDS, "a", PLAIN);
    expect([...next.ids]).toEqual([]);
    expect(next.anchorId).toBe("a");
  });

  it("keeps the clicked row when it is selected alongside others", () => {
    const next = applySelectionClick(selection(["a", "b"], "a"), IDS, "a", PLAIN);
    expect([...next.ids]).toEqual(["a"]);
  });

  it("extends a range forward from the anchor, leaving the anchor put", () => {
    const next = applySelectionClick(selection(["b"], "b"), IDS, "d", SHIFT);
    expect([...next.ids]).toEqual(["b", "c", "d"]);
    expect(next.anchorId).toBe("b");
  });

  it("extends a range backward from the anchor", () => {
    const next = applySelectionClick(selection(["c"], "c"), IDS, "a", SHIFT);
    expect([...next.ids]).toEqual(["a", "b", "c"]);
    expect(next.anchorId).toBe("c");
  });

  it("falls back to a plain click when shift has no anchor", () => {
    const next = applySelectionClick(emptySelection, IDS, "c", SHIFT);
    expect([...next.ids]).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });

  it("adds a row on toggle and moves the anchor there", () => {
    const next = applySelectionClick(selection(["a"], "a"), IDS, "c", TOGGLE);
    expect([...next.ids]).toEqual(["a", "c"]);
    expect(next.anchorId).toBe("c");
  });

  it("removes a selected row on toggle", () => {
    const next = applySelectionClick(selection(["a", "c"], "a"), IDS, "a", TOGGLE);
    expect([...next.ids]).toEqual(["c"]);
    expect(next.anchorId).toBe("a");
  });
});

describe("targetsForContextClick", () => {
  it("targets the whole selection when the clicked row is in it", () => {
    const sel = selection(["a", "c"], "a");
    const result = targetsForContextClick(sel, "c");
    expect(result.targetIds).toEqual(["a", "c"]);
    expect(result.selection).toBe(sel);
  });

  it("selects just the clicked row when it is outside the selection", () => {
    const result = targetsForContextClick(selection(["a"], "a"), "d");
    expect(result.targetIds).toEqual(["d"]);
    expect([...result.selection.ids]).toEqual(["d"]);
    expect(result.selection.anchorId).toBe("d");
  });
});

describe("pruneSelection", () => {
  it("drops ids that have left the list", () => {
    const next = pruneSelection(selection(["a", "z"], "z"), IDS);
    expect([...next.ids]).toEqual(["a"]);
    expect(next.anchorId).toBeNull();
  });

  it("returns the same selection when nothing moved", () => {
    const sel = selection(["a"], "a");
    expect(pruneSelection(sel, IDS)).toBe(sel);
  });
});

describe("toPlaylistTracks", () => {
  it("drops the queue identity", () => {
    expect(toPlaylistTracks([{ id: "row-1", uri: "spotify:track:x", trackId: "x" }])).toEqual([
      { uri: "spotify:track:x", trackId: "x" },
    ]);
  });
});
