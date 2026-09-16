import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./Button";
import { HintLine } from "./HintLine";
import { Modal } from "./Modal";

export interface ConfirmModalProps {
  /** false renders nothing. */
  open: boolean;
  title: string;
  /** What confirming will do, in the caller's own words. */
  children: ReactNode;
  /** The confirm button's text. Name the act — "Delete", not "OK". */
  confirmLabel: string;
  /** Matches the weight of the act; destructive ones say so. */
  confirmVariant?: ButtonVariant;
  /** Runs the act. Closing is the caller's to do, as it is for a cancel. */
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Asks before an act that cannot be undone from the page that started it.
 *
 * Cancel comes first and takes focus, so Escape, the backdrop and the first
 * key all mean the same thing: nothing happens.
 */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  confirmVariant = "danger",
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={confirmVariant} size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <HintLine tone="muted">{children}</HintLine>
    </Modal>
  );
}
