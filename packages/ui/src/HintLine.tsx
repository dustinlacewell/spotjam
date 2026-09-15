import type { ReactNode } from "react";
import styles from "./HintLine.module.css";

export type HintLineTone = "error" | "muted";

const toneClass: Record<HintLineTone, string> = {
  error: styles.error,
  muted: styles.muted,
};

function classes(tone: HintLineTone, reserveSpace: boolean): string {
  return [
    styles.base,
    toneClass[tone],
    reserveSpace ? styles.reserve : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface HintLineProps {
  children?: ReactNode;
  tone?: HintLineTone;
  reserveSpace?: boolean;
}

/* Always renders the <p>, even with empty children, so the reserved
   space survives an empty hint. */
export function HintLine({
  children,
  tone = "muted",
  reserveSpace = true,
}: HintLineProps) {
  return <p className={classes(tone, reserveSpace)}>{children}</p>;
}
