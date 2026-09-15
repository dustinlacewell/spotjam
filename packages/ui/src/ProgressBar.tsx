import type { KeyboardEvent, MouseEvent } from "react";
import styles from "./ProgressBar.module.css";

const ARROW_STEP = 0.02;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface ProgressBarProps {
  fraction: number;
  seekable?: boolean;
  onSeek?: (fraction: number) => void;
  "aria-label"?: string;
  labels?: { left: string; right: string };
}

export function ProgressBar({
  fraction,
  seekable = false,
  onSeek,
  "aria-label": ariaLabel,
  labels,
}: ProgressBarProps) {
  const position = clamp01(fraction);
  const interactive = seekable && onSeek !== undefined;

  const fill = (
    <div className={styles.fill} style={{ width: `${position * 100}%` }}>
      {interactive ? <span className={styles.knob} /> : null}
    </div>
  );

  const labelRow = labels ? (
    <div className={styles.labels}>
      <span>{labels.left}</span>
      <span>{labels.right}</span>
    </div>
  ) : null;

  if (!interactive) {
    return (
      <div>
        <div className={styles.track} aria-label={ariaLabel}>
          {fill}
        </div>
        {labelRow}
      </div>
    );
  }

  const seek = onSeek;

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    seek(clamp01((event.clientX - rect.left) / rect.width));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seek(clamp01(position - ARROW_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seek(clamp01(position + ARROW_STEP));
    }
  };

  return (
    <div>
      <div
        className={`${styles.track} ${styles.seekable}`}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={position}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {fill}
      </div>
      {labelRow}
    </div>
  );
}
