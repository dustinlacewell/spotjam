/** What one focusable thing in a menu is: a text field, or an item. */
export type FocusTarget = "field" | "item";

/** Where focus lands when the menu opens. A field wins, so typing filters at
 *  once; with no field, the first item. */
export function openingFocus(targets: FocusTarget[]): number {
  const field = targets.indexOf("field");
  return field >= 0 ? field : 0;
}

/** The item Enter takes from the field at `from`: the first one below it,
 *  which is the top match. Items above the field are not what it filters. */
export function itemBelow(targets: FocusTarget[], from: number): number | null {
  for (let index = from + 1; index < targets.length; index++) {
    if (targets[index] === "item") return index;
  }
  return null;
}

/** Where an arrow, Home or End key moves focus from `current`, or null for
 *  any other key. A `current` of -1 means nothing in the menu has focus. */
export function nextIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
