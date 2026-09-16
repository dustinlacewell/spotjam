import { Pause, Play, SkipForward } from "lucide-react";
import { IconButton, ProgressBar, Thumbnail } from "@spotjam/ui";
import type { QueueItem } from "@spotjam/protocol";
import { trackProgressView, type PlaybackProgress } from "../lib/progress";
import { toPlaylistTracks } from "../lib/selection";
import { TrackContextMenu } from "./TrackContextMenu";
import { useTrackContextMenu } from "./use-track-context-menu";
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
  progress: PlaybackProgress | null;
  isPaused: boolean;
  onTogglePause: () => void;
  onSkip: () => void;
  onSeek: (positionMs: number) => void;
}) {
  const metadata = useTrackMetadata(item?.uri ?? "");
  const menu = useTrackContextMenu();

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
    <div
      className={styles.hero}
      // The hero names one track, so the menu acts on that one wherever in it
      // the click lands — there is no selection here to read.
      onContextMenu={(e) => menu.open(e, toPlaylistTracks([item]))}
    >
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

      <TrackContextMenu at={menu.at} tracks={menu.tracks} onClose={menu.close} />
    </div>
  );
}

const ARROW_STEP_MS = 5000;

/**
 * ProgressBar speaks in fractions; playback speaks in milliseconds. This is
 * the one place that conversion happens, including the 5s arrow-key step
 * (a duration-aware amount ProgressBar's own 2% default can't know).
 *
 * `trackProgressView` decides what each half shows; only seeking is left here,
 * since it needs the measured length the view has already folded away.
 */
function TrackProgress({
  progress,
  onSeek,
}: {
  progress: PlaybackProgress | null;
  onSeek: (positionMs: number) => void;
}) {
  const view = trackProgressView(progress);
  const durationMs = view.seekable && progress?.kind === "measured" ? progress.durationMs : null;

  return (
    <div className={styles.progress}>
      {/*
        With no length the bar draws nothing: fraction 0 and no seek handler
        leave an empty, inert track rather than a fill implying a position
        inside a length nobody knows. `view.indeterminate` marks that state for
        a future ProgressBar that can style it.
      */}
      <ProgressBar
        fraction={view.fraction}
        seekable={durationMs !== null}
        onSeek={
          durationMs !== null
            ? (nextFraction) => onSeek(fractionToMsWithStep(nextFraction, view.fraction, durationMs))
            : undefined
        }
        aria-label={durationMs !== null ? "Seek" : undefined}
      />
      <div className={styles.progressClocks}>
        <span>{view.elapsedText}</span>
        <span>{view.trailingText}</span>
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
