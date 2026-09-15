import type { ReactNode } from "react";
import styles from "./Chip.module.css";

export type ChipTone = "muted" | "accent";

const toneClass: Record<ChipTone, string> = {
  muted: styles.muted,
  accent: styles.accent,
};

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
}

export function Chip({ children, tone = "muted" }: ChipProps) {
  return (
    <span className={[styles.base, toneClass[tone]].join(" ")}>{children}</span>
  );
}
