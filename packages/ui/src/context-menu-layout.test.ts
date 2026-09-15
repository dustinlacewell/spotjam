import { describe, expect, it } from "vitest";
import { clampToViewport } from "./context-menu-layout";

const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 300 };

describe("clampToViewport", () => {
  it("leaves a menu that fits where it was opened", () => {
    expect(clampToViewport({ x: 100, y: 100 }, size, viewport)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("shifts left when the menu overflows the right edge", () => {
    expect(clampToViewport({ x: 900, y: 100 }, size, viewport)).toEqual({
      x: 792,
      y: 100,
    });
  });

  it("shifts up when the menu overflows the bottom edge", () => {
    expect(clampToViewport({ x: 100, y: 700 }, size, viewport)).toEqual({
      x: 100,
      y: 492,
    });
  });

  it("shifts on both axes when the menu overflows both edges", () => {
    expect(clampToViewport({ x: 900, y: 700 }, size, viewport)).toEqual({
      x: 792,
      y: 492,
    });
  });

  it("clamps to the margin when the menu is bigger than the viewport", () => {
    const huge = { width: 2000, height: 1600 };
    expect(clampToViewport({ x: 400, y: 400 }, huge, viewport)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("honours a custom margin", () => {
    expect(clampToViewport({ x: 900, y: 100 }, size, viewport, 20)).toEqual({
      x: 780,
      y: 100,
    });
  });
});
