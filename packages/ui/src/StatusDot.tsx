import styles from "./StatusDot.module.css";

export type StatusDotTone = "accent" | "muted" | "danger" | "warning" | "current";

const toneClass: Record<StatusDotTone, string> = {
  accent: styles.accent,
  muted: styles.muted,
  danger: styles.danger,
  warning: styles.warning,
  current: styles.current,
};

function classes(tone: StatusDotTone, pulse: boolean, glow: boolean): string {
  return [
    styles.base,
    toneClass[tone],
    glow ? styles.glow : undefined,
    pulse ? styles.pulse : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface StatusDotProps {
  tone?: StatusDotTone;
  size?: number;
  pulse?: boolean;
  glow?: boolean;
  title?: string;
}

export function StatusDot({
  tone = "accent",
  size = 8,
  pulse = false,
  glow = false,
  title,
}: StatusDotProps) {
  return (
    <span
      className={classes(tone, pulse, glow)}
      style={{ width: size, height: size }}
      title={title}
    />
  );
}
