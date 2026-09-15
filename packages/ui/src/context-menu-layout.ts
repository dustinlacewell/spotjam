export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Returns the top-left for a menu of `size` opened at `at`, shifted so it
 *  stays inside `viewport` with `margin` px of slack. */
export function clampToViewport(
  at: Point,
  size: Size,
  viewport: Size,
  margin = 8,
): Point {
  return {
    x: clampAxis(at.x, size.width, viewport.width, margin),
    y: clampAxis(at.y, size.height, viewport.height, margin),
  };
}

function clampAxis(
  start: number,
  extent: number,
  available: number,
  margin: number,
): number {
  const shifted =
    start + extent + margin > available ? available - extent - margin : start;
  return Math.max(margin, shifted);
}
