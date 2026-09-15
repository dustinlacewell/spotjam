import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";

export interface ModalProps {
  /** false renders nothing. */
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The dialog's buttons, laid out in a right-aligned row. */
  actions?: ReactNode;
}

/**
 * A centered dialog over a backdrop. Escape and a click on the backdrop close
 * it; the first control inside takes focus when it opens.
 *
 * Like ContextMenu, it portals to the body so no ancestor's overflow or stacking
 * context can clip it.
 */
export function Modal({ open, title, onClose, children, actions }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    focusables(ref.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      // Only a press that both starts and ends on the backdrop closes it, so a
      // drag that finishes outside the dialog does not dismiss it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={styles.dialog}
      >
        <h2 className={styles.title}>{title}</h2>
        {children}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "input:not([disabled]), button:not([disabled]), textarea:not([disabled])",
    ),
  );
}
