import type { ReactNode } from "react";
import styles from "./Pill.module.css";

export type PillTone = "neutral" | "accent" | "danger";

const toneClass: Record<PillTone, string> = {
  neutral: styles.neutral,
  accent: styles.accent,
  danger: styles.danger,
};

export interface PillProps {
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tone?: PillTone;
  onClick?: () => void;
  as?: "button" | "span";
  title?: string;
}

export function Pill({
  children,
  active = false,
  disabled = false,
  tone = "neutral",
  onClick,
  as = "button",
  title,
}: PillProps) {
  const isButton = as === "button";

  const className = [
    styles.base,
    toneClass[tone],
    isButton ? (disabled ? styles.disabled : styles.interactive) : styles.static,
    active ? styles.active : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (!isButton) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
