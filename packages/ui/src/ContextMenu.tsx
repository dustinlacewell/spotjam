import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { clampToViewport } from "./context-menu-layout";
import type { Point } from "./context-menu-layout";
import { itemBelow, nextIndex, openingFocus } from "./context-menu-focus";
import type { FocusTarget } from "./context-menu-focus";
import styles from "./ContextMenu.module.css";

const CloseContext = createContext<() => void>(() => {});

export interface ContextMenuProps {
  /** null closes the menu. */
  at: Point | null;
  onClose: () => void;
  children: ReactNode;
}

export function ContextMenu({ at, onClose, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (at === null || el === null) {
      setPlaced(null);
      return;
    }
    const box = el.getBoundingClientRect();
    setPlaced(
      clampToViewport(
        at,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [at]);

  // focus() is a no-op while the menu is still visibility: hidden, so wait
  // until placement has been applied.
  useEffect(() => {
    if (placed === null) return;
    const el = ref.current;
    if (el === null) return;
    const targets = focusables(el);
    targets[openingFocus(targets.map(targetOf))]?.focus();
  }, [placed]);

  useEffect(() => {
    if (at === null) return;

    const outside = (event: Event) =>
      !(event.target instanceof Node) ||
      ref.current === null ||
      !ref.current.contains(event.target);

    const closeIfOutside = (event: Event) => {
      if (outside(event)) onClose();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (outside(event)) onClose();
      else event.preventDefault();
    };
    const closeIfScrolledOutside = (event: Event) => {
      if (outside(event)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      event.stopPropagation();
    };

    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", closeIfScrolledOutside, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", closeIfScrolledOutside, true);
      window.removeEventListener("blur", onClose);
    };
  }, [at, onClose]);

  const onMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    const el = ref.current;
    if (el === null) return;
    const targets = focusables(el);
    if (targets.length === 0) return;
    const kinds = targets.map(targetOf);
    const current = targets.indexOf(document.activeElement as HTMLElement);
    const inInput = kinds[current] === "field";

    if (event.key === "Enter") {
      if (!inInput) return;
      const item = itemBelow(kinds, current);
      if (item === null) return;
      event.preventDefault();
      targets[item]?.click();
      return;
    }

    // Home/End belong to the text cursor while the filter field has focus.
    if (inInput && (event.key === "Home" || event.key === "End")) return;

    const next = nextIndex(event.key, current, targets.length);
    if (next === null) return;
    event.preventDefault();
    targets[next]?.focus();
  }, []);

  if (at === null) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={styles.menu}
      style={{
        left: placed?.x ?? at.x,
        top: placed?.y ?? at.y,
        visibility: placed === null ? "hidden" : undefined,
      }}
      onKeyDown={onMenuKeyDown}
    >
      <CloseContext.Provider value={onClose}>{children}</CloseContext.Provider>
    </div>,
    document.body,
  );
}

export interface ContextMenuItemProps {
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function ContextMenuItem({
  onSelect,
  disabled = false,
  children,
}: ContextMenuItemProps) {
  const close = useContext(CloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      disabled={disabled}
      aria-disabled={disabled}
      onClick={() => {
        onSelect();
        close();
      }}
    >
      {children}
    </button>
  );
}

/** A line between groups of items. Focus passes over it. */
export function ContextMenuSeparator() {
  return <div role="separator" className={styles.separator} />;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      'input:not([disabled]), button[role="menuitem"]:not([disabled])',
    ),
  );
}

function targetOf(el: HTMLElement): FocusTarget {
  return el instanceof HTMLInputElement ? "field" : "item";
}
