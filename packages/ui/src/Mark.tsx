import type { ReactNode } from "react";
import styles from "./Mark.module.css";

export type MarkSize = "sm" | "md" | "lg";

const sizeClass: Record<MarkSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const dotClass: Record<MarkSize, string> = {
  sm: styles.dotMd,
  md: styles.dotMd,
  lg: styles.dotLg,
};

export interface MarkProps {
  size?: MarkSize;
  dot?: boolean;
  children?: ReactNode;
}

export function Mark({ size = "md", dot = true, children }: MarkProps) {
  const showDot = dot && size !== "sm";

  return (
    <div className={`${styles.base} ${sizeClass[size]}`}>
      {showDot ? <span className={`${styles.dot} ${dotClass[size]}`} /> : null}
      {children ?? "spotjam"}
    </div>
  );
}
