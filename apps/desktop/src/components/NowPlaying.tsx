import type { KeyboardEvent, MouseEvent } from "react";
import type { QueueItem } from "../lib/room";
import { formatClock } from "../lib/progress";
import { useTrackMetadata } from "../lib/use-track-metadata";
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
  item: QueueItem | null;
  ownerName: string;
  progress: { positionMs: number; durationMs: number } | null;
  isPaused: boolean;
  onTogglePause: () => void;
  onSkip: () => void;
  onSeek: (positionMs: number) => void;
}) {
  const metadata = useTrackMetadata(item?.uri ?? "");

  if (!item) {
    return (
      <div className={styles.hero}>
        <div className={styles.emptyState}>
          <div className={styles.emptyArt} />
          <div>
            <p className={styles.emptyTitle}>Nothing queued yet</p>
            <p className={styles.emptySubtitle}>Paste a Spotify link below to start the session</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.hero}>
      <div className={styles.art}>
        {metadata?.thumbnailUrl && <img src={metadata.thumbnailUrl} alt="" />}
      </div>
      <div className={styles.info}>
        <div className={isPaused ? styles.labelIdle : styles.label}>
          <span className={isPaused ? styles.pulseIdle : styles.pulse} />
          {isPaused ? "Paused" : "Now playing"}
        </div>
        <p className={styles.title}>{metadata?.title ?? item.trackId}</p>
        <p className={styles.artist}>{metadata?.artist ?? " "}</p>
        <ProgressBar progress={progress} onSeek={onSeek} />
        <p className={styles.addedBy}>from {ownerName}</p>
      </div>
      <div className={styles.controls}>
        <button
          className={styles.controlButton}
          onClick={onTogglePause}
          aria-label={isPaused ? "Resume" : "Pause"}
        >
          {isPaused ? "▶" : "❚❚"}
        </button>
        <button className={styles.controlButton} onClick={onSkip} aria-label="Skip">
          ⏭
        </button>
      </div>
    </div>
  );
}

/**
 * Position within the playing track. Renders empty, with placeholder clocks, until a sample
 * arrives. Once a sample with a real duration exists, the track is a seek slider: click anywhere
 * to jump, or focus it and step with the arrow keys.
 */
function ProgressBar({
  progress,
  onSeek,
}: {
  progress: { positionMs: number; durationMs: number } | null;
  onSeek: (positionMs: number) => void;
}) {
  /** The track to seek within, or null when there is nothing seekable yet. */
  const seekTrack = progress !== null && progress.durationMs > 0 ? progress : null;
  const fraction = seekTrack ? clamp(seekTrack.positionMs / seekTrack.durationMs, 0, 1) : 0;

  function seekToClick(event: MouseEvent<HTMLDivElement>) {
    if (!seekTrack) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const clicked = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onSeek(Math.round(clicked * seekTrack.durationMs));
  }

  function seekByKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!seekTrack) return;
    const step =
      event.key === "ArrowLeft" ? -ARROW_STEP_MS : event.key === "ArrowRight" ? ARROW_STEP_MS : 0;
    if (step === 0) return;
    event.preventDefault();
    onSeek(Math.round(clamp(seekTrack.positionMs + step, 0, seekTrack.durationMs)));
  }

  return (
    <div className={styles.progress}>
      <div className={styles.progressRow}>
        <div
          className={seekTrack ? styles.progressTrackSeekable : styles.progressTrack}
          onClick={seekToClick}
          onKeyDown={seekByKey}
          role={seekTrack ? "slider" : undefined}
          tabIndex={seekTrack ? 0 : undefined}
          aria-label={seekTrack ? "Seek" : undefined}
          aria-valuemin={seekTrack ? 0 : undefined}
          aria-valuemax={seekTrack ? seekTrack.durationMs : undefined}
          aria-valuenow={seekTrack ? seekTrack.positionMs : undefined}
          aria-valuetext={seekTrack ? formatClock(seekTrack.positionMs) : undefined}
        >
          <div className={styles.progressFill} style={{ width: `${fraction * 100}%` }}>
            <span className={styles.progressKnob} />
          </div>
        </div>
      </div>
      <div className={styles.progressClocks}>
        <span>{progress ? formatClock(progress.positionMs) : PLACEHOLDER_CLOCK}</span>
        <span>{progress ? formatClock(progress.durationMs) : PLACEHOLDER_CLOCK}</span>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const ARROW_STEP_MS = 5000;
const PLACEHOLDER_CLOCK = "–:––";
