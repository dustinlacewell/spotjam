import type { ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClass: Record<ButtonVariant, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
};

const sizeClass: Record<ButtonSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

function classes(variant: ButtonVariant, size: ButtonSize): string {
  return [styles.base, variantClass[variant], sizeClass[size]].join(" ");
}

export interface ButtonProps {
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  children,
  type = "button",
  disabled = false,
  onClick,
  title,
  "aria-label": ariaLabel,
  variant = "primary",
  size = "lg",
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(variant, size)}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps {
  children: ReactNode;
  href: string;
  target?: string;
  rel?: string;
  title?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function ButtonLink({
  children,
  href,
  target,
  rel,
  title,
  variant = "primary",
  size = "lg",
}: ButtonLinkProps) {
  return (
    <a
      href={href}
      target={target}
      rel={rel}
      title={title}
      className={classes(variant, size)}
    >
      {children}
    </a>
  );
}
