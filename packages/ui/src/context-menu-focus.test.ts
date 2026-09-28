import { describe, expect, it } from "vitest";
import { itemBelow, nextIndex, openingFocus } from "./context-menu-focus";

describe("openingFocus", () => {
  it("focuses the field, even below an item", () => {
    expect(openingFocus(["item", "field", "item"])).toBe(1);
  });

  it("focuses the first item when there is no field", () => {
    expect(openingFocus(["item", "item"])).toBe(0);
  });
});

describe("itemBelow", () => {
  it("takes the first item below the field, not one above it", () => {
    expect(itemBelow(["item", "field", "item", "item"], 1)).toBe(2);
  });

  it("finds nothing when no item sits below the field", () => {
    expect(itemBelow(["item", "field"], 1)).toBeNull();
  });
});

describe("nextIndex", () => {
  it("wraps down past the last target", () => {
    expect(nextIndex("ArrowDown", 2, 3)).toBe(0);
  });

  it("wraps up past the first target", () => {
    expect(nextIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("starts at an end when nothing has focus", () => {
    expect(nextIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("ignores other keys", () => {
    expect(nextIndex("a", 0, 3)).toBeNull();
  });
});
