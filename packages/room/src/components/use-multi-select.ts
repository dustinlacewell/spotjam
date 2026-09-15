import { useCallback, useEffect, useRef, useState } from "react";
import {
  applySelectionClick,
  emptySelection,
  pruneSelection,
  targetsForContextClick,
  type Selection,
} from "../lib/selection";

/**
 * Row selection for a list of tracks: the clicking rules live in lib/selection,
 * this holds the state and prunes it as the list underneath moves.
 */
export function useMultiSelect(orderedIds: readonly string[]): {
  selection: Selection;
  isSelected(id: string): boolean;
  onRowClick(e: React.MouseEvent, id: string): void;
  contextTargets(id: string): string[];
  clear(): void;
} {
  const [selection, setSelection] = useState<Selection>(emptySelection);

  // The click handlers need the live list without re-identifying on every
  // render, so the rows they are attached to stay stable.
  const idsRef = useRef(orderedIds);
  idsRef.current = orderedIds;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const key = orderedIds.join("|");
  useEffect(() => {
    setSelection((current) => pruneSelection(current, idsRef.current));
  }, [key]);

  const onRowClick = useCallback((e: React.MouseEvent, id: string) => {
    setSelection((current) =>
      applySelectionClick(current, idsRef.current, id, {
        shift: e.shiftKey,
        toggle: e.ctrlKey || e.metaKey,
      }),
    );
  }, []);

  // The targets are needed now, to build the menu, so the selection is read and
  // written here rather than derived from the state this call queues.
  const contextTargets = useCallback((id: string) => {
    const result = targetsForContextClick(selectionRef.current, id);
    selectionRef.current = result.selection;
    setSelection(result.selection);
    return result.targetIds;
  }, []);

  return {
    selection,
    isSelected: useCallback((id: string) => selection.ids.has(id), [selection]),
    onRowClick,
    contextTargets,
    clear: useCallback(() => setSelection(emptySelection), []),
  };
}
