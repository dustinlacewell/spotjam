import { Pause, Play, SkipForward } from "lucide-react";
import { IconButton, ProgressBar, Thumbnail } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import { formatClock } from "../lib/progress";
import { useTrackMetadata } from "./use-track-metadata";
import styles from "./NowPlaying.module.css";

export function NowPlaying({
  item,
  ownerName,
  progress,
  isPaused,
  onTogglePause,
  onSkip,
  onSeek,
}: {
  /** The playing track, or null when nothing is. */
  item: QueueItem | null;
  ownerName: string;
  progress: { positionMs: number; durationMs: number } | null;
  isPaused: boolean;
  onTogglePause: () => void;
  onSkip: () => void;
  onSeek: (positionMs: number) => void;
}) {
  const metadata = useTrackMetadata(item?.uri ?? "");

  if (item === null) {
    return (
      <div className={styles.hero}>
        <div className={styles.emptyState}>
          <div className={styles.emptyArt} />
          <div>
            <p className={styles.emptyTitle}>Empty Queue</p>
            <p className={styles.emptySubtitle}>Add a song to the queue!</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.hero}>
      <Thumbnail src={metadata?.thumbnailUrl ?? null} size={96} radius="md" />
      <div className={styles.info}>
        <div className={isPaused ? styles.labelIdle : styles.label}>
          {isPaused ? `${ownerName} paused` : `${ownerName} is playing`}
        </div>
        <p className={styles.title}>{metadata?.title ?? item.trackId}</p>
        <p className={styles.artist}>{metadata?.artist ?? " "}</p>
        <TrackProgress progress={progress} onSeek={onSeek} />
      </div>
      <div className={styles.controls}>
        <IconButton
          shape="circle"
          size="md"
          tone="neutral"
          className={styles.playButton}
          onClick={onTogglePause}
          label={isPaused ? "Resume" : "Pause"}
        >
          {isPaused ? <Play size={16} strokeWidth={2} /> : <Pause size={16} strokeWidth={2} />}
        </IconButton>
        <IconButton
          shape="circle"
          size="md"
          tone="neutral"
          className={styles.skipButton}
          onClick={onSkip}
          label="Skip"
        >
          <SkipForward size={16} strokeWidth={2} />
        </IconButton>
      </div>
    </div>
  );
}

const ARROW_STEP_MS = 5000;
const PLACEHOLDER_CLOCK = "–:––";

/**
 * ProgressBar speaks in fractions; playback speaks in milliseconds. This is
 * the one place that conversion happens, including the 5s arrow-key step
 * (a duration-aware amount ProgressBar's own 2% default can't know).
 */
function TrackProgress({
  progress,
  onSeek,
}: {
  progress: { positionMs: number; durationMs: number } | null;
  onSeek: (positionMs: number) => void;
}) {
  const seekTrack = progress !== null && progress.durationMs > 0 ? progress : null;
  const fraction = seekTrack ? seekTrack.positionMs / seekTrack.durationMs : 0;

  return (
    <div className={styles.progress}>
      <ProgressBar
        fraction={fraction}
        seekable={seekTrack !== null}
        onSeek={
          seekTrack
            ? (nextFraction) => onSeek(fractionToMsWithStep(nextFraction, fraction, seekTrack.durationMs))
            : undefined
        }
        aria-label={seekTrack ? "Seek" : undefined}
      />
      <div className={styles.progressClocks}>
        <span>{progress ? formatClock(progress.positionMs) : PLACEHOLDER_CLOCK}</span>
        <span>{progress ? formatClock(progress.durationMs) : PLACEHOLDER_CLOCK}</span>
      </div>
    </div>
  );
}

/**
 * A click seeks to wherever ProgressBar computed. An arrow key moves it by
 * ProgressBar's fixed 2% step, which we widen back out to a fixed 5s so the
 * step size doesn't shrink on long tracks and balloon on short ones.
 */
function fractionToMsWithStep(nextFraction: number, prevFraction: number, durationMs: number): number {
  const isArrowStep = Math.abs(nextFraction - prevFraction - 0.02) < 1e-6 ||
    Math.abs(nextFraction - prevFraction + 0.02) < 1e-6;
  if (!isArrowStep) return Math.round(nextFraction * durationMs);
  const direction = nextFraction > prevFraction ? 1 : -1;
  const positionMs = (prevFraction * durationMs) + direction * ARROW_STEP_MS;
  return Math.min(durationMs, Math.max(0, Math.round(positionMs)));
}
