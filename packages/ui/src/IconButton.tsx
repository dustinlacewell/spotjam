import type { ReactNode } from "react";
import styles from "./IconButton.module.css";

export type IconButtonTone = "neutral" | "accent" | "danger";
export type IconButtonSize = "sm" | "md";

const toneClass: Record<IconButtonTone, string> = {
  neutral: styles.neutral,
  accent: styles.accent,
  danger: styles.danger,
};

const sizeClass: Record<IconButtonSize, string> = {
  sm: styles.sm,
  md: styles.md,
};

const shapeClass: Record<"square" | "circle", string> = {
  square: styles.square,
  circle: styles.circle,
};

export interface IconButtonProps {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  size?: IconButtonSize;
  shape?: "square" | "circle";
  tone?: IconButtonTone;
  revealOnHover?: boolean;
  className?: string;
}

export function IconButton({
  children,
  label,
  onClick,
  disabled = false,
  size = "md",
  shape = "square",
  tone = "neutral",
  revealOnHover = false,
  className: extraClassName,
}: IconButtonProps) {
  const className = [
    styles.base,
    shapeClass[shape],
    sizeClass[size],
    toneClass[tone],
    extraClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...(revealOnHover ? { "data-ui-reveal": "" } : {})}
    >
      {children}
    </button>
  );
}
