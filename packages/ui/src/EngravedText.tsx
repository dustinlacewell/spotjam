import type { ReactNode } from "react";
import styles from "./EngravedText.module.css";

export interface EngravedTextProps {
  children?: ReactNode;
  className?: string;
}

/** A short label stamped into the panel, for an empty-state line among plain rows. */
export function EngravedText({ children, className }: EngravedTextProps) {
  return <p className={[styles.base, className].filter(Boolean).join(" ")}>{children}</p>;
}
