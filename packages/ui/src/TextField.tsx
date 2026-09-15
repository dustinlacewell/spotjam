import type { ChangeEvent, FocusEvent, KeyboardEvent } from "react";
import styles from "./TextField.module.css";

export type TextFieldSize = "sm" | "md" | "lg";
export type TextFieldAlign = "left" | "center";

const sizeClass: Record<TextFieldSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

/* "left" is the browser default, so it earns no class of its own. */
const alignClass: Record<TextFieldAlign, string | undefined> = {
  left: undefined,
  center: styles.center,
};

function classes(
  size: TextFieldSize,
  align: TextFieldAlign,
  emphasis: boolean,
): string {
  return [
    styles.base,
    sizeClass[size],
    alignClass[align],
    emphasis ? styles.emphasis : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  align?: TextFieldAlign;
  size?: TextFieldSize;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  onFocus?: (e: FocusEvent<HTMLInputElement>) => void;
  emphasis?: boolean;
  disabled?: boolean;
}

export function TextField({
  value,
  onChange,
  placeholder,
  align = "left",
  size = "md",
  autoFocus,
  spellCheck,
  maxLength,
  onKeyDown,
  onBlur,
  onFocus,
  emphasis = false,
  disabled,
}: TextFieldProps) {
  return (
    <input
      type="text"
      className={classes(size, align, emphasis)}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={spellCheck}
      maxLength={maxLength}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onFocus={onFocus}
      disabled={disabled}
    />
  );
}
