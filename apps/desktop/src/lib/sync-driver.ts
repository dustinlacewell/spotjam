import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { PlaybackPointer, Room } from "./room";
import { positionMs } from "./playback-clock";
import { nextControlState, type ControlState, type LocalPlayback } from "./control-state";

const POLL_INTERVAL_MS = 2000;
const TRACK_END_GRACE_MS = 1500;
/**
 * How long past the shared clock's end of track the fallback timer waits.
 * Spotify's own gapless transition into the queued track normally happens
 * first; this timer only covers the case where it did not.
 */
const TRACK_END_FALLBACK_MS = 1500;
/** How close to the end of a track a pause must be to read as "it finished". */
const TRACK_END_SLACK_MS = 1500;
/** How far past a track's own duration the room may sit before we call it over. */
const DURATION_OVERRUN_MS = 3000;
/** Local drift this far from the shared clock is corrected by seeking. */
const MAX_DRIFT_MS = 3000;
/** Below this, a late join is close enough to the top that seeking is not worth it. */
const SEEK_THRESHOLD_MS = 2000;

export interface PlayerState {
  trackUri: string | null;
  trackName: string | null;
  isPaused: boolean;
  positionMs: number;
  durationMs: number;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The part of a pointer that says *where* in the item the room is. */
interface Clock {
  startedAtEpochMs: number;
  pausedAtOffsetMs: number;
}

function clockOf(pointer: PlaybackPointer): Clock {
  return {
    startedAtEpochMs: pointer.startedAtEpochMs,
    pausedAtOffsetMs: pointer.pausedAtOffsetMs,
  };
}

function sameClock(a: Clock | null, b: Clock): boolean {
  return (
    a !== null &&
    a.startedAtEpochMs === b.startedAtEpochMs &&
    a.pausedAtOffsetMs === b.pausedAtOffsetMs
  );
}

/**
 * Wires a joined room to the local Spotify client: plays whatever the shared
 * playback pointer names, seeks to the position the shared clock implies, and
 * mirrors pause/resume. Pure glue: the state lives on the server, the clock in
 * `playback-clock`.
 *
 * The server has no clock, so it cannot know a track ran out: something has to
 * tell it. That is the pointer item's own owner, and only the owner — it sends
 * `skip` once the track it queued has finished, and the server decides what
 * plays next. Every other client sees the end, stops reporting progress, and
 * waits for the snapshot.
 *
 * None of that happens unless this client is actually driving the player. The
 * user may be listening to their own music instead; `control-state` decides,
 * and every command and every end detector that reads the player is gated on
 * `following`. Only the clock-based end timer runs in all states, because it
 * reads the room, not the player.
 */
export class SyncDriver {
  private lastAppliedItemId: string | null = null;
  /** Do we drive the local player? Null until the first evaluation. */
  private control: ControlState | null = null;
  /** The pointer item the control state was last evaluated against. */
  private lastPointerItemId: string | null = null;
  private lastAppliedPaused: boolean | null = null;
  /** The pointer clock the local player was last placed on, for remote-seek detection. */
  private lastAppliedClock: Clock | null = null;
  /** Fires shortly after the pointer's track runs out, so the poll loop settles. */
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  /** The item the pending end timer was scheduled for. */
  private endTimerItemId: string | null = null;
  /** The instant the pending end timer is aimed at, so an unchanged end is not rescheduled. */
  private endTimerAtEpochMs: number | null = null;
  /**
   * True once a poll has actually seen Spotify playing the pointer's track.
   * Until then "Spotify is on some other track" means our play command has
   * not landed yet, not that the track finished.
   */
  private observedOnTrack = false;
  /**
   * The uri last handed to Spotify's own queue. `undefined` means we have never
   * set it, so the first sync always talks to Spotify even if the head is null.
   */
  private lastSetNextUri: string | null | undefined = undefined;
  /**
   * The item we have already reported as finished. Four detectors can see the
   * same end; this makes sure only the first one sends `skip`.
   */
  private skippedItemId: string | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private unsubscribeChange: (() => void) | null = null;
  private readonly reportedErrors = new Set<string>();

  constructor(
    private readonly room: Room,
    private readonly invoke: Invoke = tauriInvoke as Invoke,
  ) {}

  start(): void {
    this.unsubscribeChange = this.room.onChange(() => {
      void this.applyPointer().then(() => this.syncNextTrack());
    });
    void this.applyPointer().then(() => this.syncNextTrack());
    this.pollHandle = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.clearEndTimer();
    this.unsubscribeChange?.();
    this.unsubscribeChange = null;
  }

  /**
   * Re-decides whether we drive the local player, and reports whether we have
   * just taken it over. Reading Spotify is best-effort: a failed read is a null
   * `LocalPlayback`, which the decision treats as "no reason to let go".
   */
  private async evaluateControl(): Promise<{ took: boolean }> {
    const pointer = this.room.getPlaybackPointer();
    const changed = pointer.itemId !== this.lastPointerItemId;
    this.lastPointerItemId = pointer.itemId;

    const state = await this.tryInvoke<PlayerState>("spotify_get_state");
    const local: LocalPlayback | null = state
      ? { trackUri: state.trackUri, isPaused: state.isPaused }
      : null;
    const next = this.room.sessionQueue()[0]?.item.uri ?? null;

    const prev = this.control;
    const control = nextControlState(prev, local, pointer, next, changed);
    this.control = control;
    if (control !== prev) {
      console.debug("spotjam: control", prev ?? "(none)", "->", control);
    }
    return { took: control === "following" && prev !== "following" };
  }

  private get following(): boolean {
    return this.control === "following";
  }

  /** Brings the local player in line with the shared pointer: track, then position, then pause. */
  private async applyPointer(now = Date.now()): Promise<void> {
    const { took } = await this.evaluateControl();
    const pointer = this.room.getPlaybackPointer();

    // An empty pointer touches nothing: whatever the user has on keeps playing.
    // Only our own bookkeeping is cleared, so the next item starts fresh.
    if (pointer.itemId === null) {
      this.forgetAppliedItem();
      return;
    }
    if (!this.following) return;

    // Taking the player over is a fresh start on this item, even though the
    // item itself did not change.
    if (pointer.itemId !== this.lastAppliedItemId || took) {
      await this.applyNewItem(pointer, now);
      return;
    }

    if (pointer.itemId === null) return;

    if (pointer.isPaused !== this.lastAppliedPaused) {
      await this.applyPauseChange(pointer, now);
      return;
    }

    if (!sameClock(this.lastAppliedClock, clockOf(pointer))) {
      await this.applySeek(pointer, now);
    }
  }

  /**
   * Keeps Spotify's own one-slot queue equal to the head of the session queue,
   * so the local player transitions gaplessly into the right track by itself.
   * An empty head clears the queue, which also stops Spotify's context autoplay
   * from inventing a track nobody asked for.
   */
  private async syncNextTrack(): Promise<void> {
    // The user's own queue is theirs while we are detached.
    if (!this.following) return;
    const next = this.room.sessionQueue()[0]?.item.uri ?? null;
    if (next === this.lastSetNextUri) return;
    this.lastSetNextUri = next;
    if (next === null) await this.tryInvoke("spotify_clear_queue");
    else await this.tryInvoke("spotify_set_next_track", { uri: next });
  }

  /** Same item, same play state, a different clock: somebody seeked the room. */
  private async applySeek(pointer: PlaybackPointer, now: number): Promise<void> {
    this.lastAppliedClock = clockOf(pointer);
    await this.tryInvoke("spotify_seek", { positionMs: positionMs(pointer, now) });
  }

  /**
   * The pointer names a different item than the one we last applied, or we have
   * just taken the local player over. Only ever called while following.
   */
  private async applyNewItem(pointer: PlaybackPointer, now: number): Promise<void> {
    this.observedOnTrack = false;
    this.clearEndTimer();
    // A new item is a fresh end to report.
    if (pointer.itemId !== this.skippedItemId) this.skippedItemId = null;

    if (pointer.itemId === null || !pointer.uri) {
      this.forgetAppliedItem();
    } else {
      await this.applyTrack(pointer, now);
    }
    await this.resyncNextTrack();
  }

  /** Drops the bookkeeping for the item we were on, without touching the player. */
  private forgetAppliedItem(): void {
    this.lastAppliedItemId = null;
    this.lastAppliedPaused = null;
    this.lastAppliedClock = null;
    this.room.setMyProgress(null);
  }

  /** The room names a track: adopt it if Spotify is already there, else start it. */
  private async applyTrack(pointer: PlaybackPointer, now: number): Promise<void> {
    this.lastAppliedItemId = pointer.itemId;
    this.lastAppliedClock = clockOf(pointer);
    const state = await this.tryInvoke<PlayerState>("spotify_get_state");
    if (state && state.trackUri === pointer.uri) {
      await this.adoptRunningTrack(pointer, state, now);
    } else {
      await this.startTrack(pointer, now);
    }
    this.lastAppliedPaused = pointer.isPaused;
  }

  /**
   * Spotify is already on the pointer's track — it transitioned there out of its
   * own queue. Re-playing it would restart the song audibly, so only the clock
   * and the pause state are corrected.
   */
  private async adoptRunningTrack(
    pointer: PlaybackPointer,
    state: PlayerState,
    now: number,
  ): Promise<void> {
    this.observedOnTrack = true;
    const expected = positionMs(pointer, now);
    if (Math.abs(state.positionMs - expected) > MAX_DRIFT_MS) {
      await this.tryInvoke("spotify_seek", { positionMs: expected });
    }
    if (pointer.isPaused) await this.tryInvoke("spotify_pause");
  }

  /** Spotify is elsewhere (or unreadable): play the track and place it on the clock. */
  private async startTrack(pointer: PlaybackPointer, now: number): Promise<void> {
    await this.tryInvoke("spotify_play_track", { uri: pointer.uri });
    const offset = positionMs(pointer, now);
    if (offset > SEEK_THRESHOLD_MS) {
      await this.tryInvoke("spotify_seek", { positionMs: offset });
    }
    if (pointer.isPaused) await this.tryInvoke("spotify_pause");
  }

  /** Spotify consumes its queue on a transition, so the slot is re-set from scratch. */
  private async resyncNextTrack(): Promise<void> {
    this.lastSetNextUri = undefined;
    await this.syncNextTrack();
  }

  /** Same item, the room pressed pause or play. Resuming re-aligns to the shared clock. */
  private async applyPauseChange(pointer: PlaybackPointer, now: number): Promise<void> {
    this.lastAppliedPaused = pointer.isPaused;
    this.lastAppliedClock = clockOf(pointer);
    if (pointer.isPaused) {
      this.clearEndTimer();
      await this.tryInvoke("spotify_pause");
      return;
    }
    await this.tryInvoke("spotify_resume");
    await this.tryInvoke("spotify_seek", { positionMs: positionMs(pointer, now) });
  }

  /** The heartbeat: corrects drift and reports where the local player sits. */
  private async poll(now = Date.now()): Promise<void> {
    const { took } = await this.evaluateControl();
    const pointer = this.room.getPlaybackPointer();

    if (pointer.itemId === null) {
      this.room.setMyProgress(null);
      return;
    }
    // We have just taken the player back: place it on the pointer before the
    // detectors below read it, or the catch-up read looks like a track end.
    if (took) {
      await this.applyNewItem(pointer, now);
      return;
    }
    if (!this.following) return;
    if (pointer.isPaused) return;

    const state = await this.tryInvoke<PlayerState>("spotify_get_state");
    if (!state) return;

    // Spotify moved into the track we queued behind this one: our track is
    // over. The owner says so; the server picks what is next.
    if (this.transitionedToNext(state, pointer)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer);
      return;
    }

    if (state.trackUri === pointer.uri) {
      this.observedOnTrack = true;
      this.room.setMyProgress({
        itemId: pointer.itemId,
        positionMs: state.positionMs,
        durationMs: state.durationMs,
        sampledAtEpochMs: now,
      });
      if (state.durationMs > 0) {
        this.scheduleEndTimer(
          pointer,
          pointer.startedAtEpochMs + state.durationMs + TRACK_END_FALLBACK_MS,
          now,
        );
      }
    }

    const playedLongEnough = now - pointer.startedAtEpochMs > TRACK_END_GRACE_MS;
    if (playedLongEnough && this.looksFinished(state, pointer.uri)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer);
      return;
    }

    if (this.ranPastDuration(state, pointer, now)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer);
      return;
    }

    if (this.shouldCorrectDrift(state, pointer)) {
      const expected = positionMs(pointer, now);
      if (Math.abs(state.positionMs - expected) > MAX_DRIFT_MS) {
        await this.tryInvoke("spotify_seek", { positionMs: expected });
      }
    }
  }

  /**
   * Aims a single timer just past the instant the shared clock reaches the
   * track's length. It is the backstop for an end Spotify never reported: when
   * it fires, the item's owner reports the end with `skip`. A seek moves
   * `endsAt`, so the timer is replaced.
   */
  private scheduleEndTimer(pointer: PlaybackPointer, endsAtEpochMs: number, now: number): void {
    if (this.endTimerItemId === pointer.itemId && this.endTimerAtEpochMs === endsAtEpochMs) return;
    this.clearEndTimer();
    const itemId = pointer.itemId;
    this.endTimerItemId = itemId;
    this.endTimerAtEpochMs = endsAtEpochMs;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.endTimerItemId = null;
      this.endTimerAtEpochMs = null;
      this.onTrackEnded(itemId);
    }, Math.max(0, endsAtEpochMs - now));
  }

  /**
   * The scheduled end arrived. Stop reporting progress for an item that has
   * run out, then — if this client owns the item — tell the server it is over.
   */
  private onTrackEnded(itemId: string | null): void {
    const pointer = this.room.getPlaybackPointer();
    if (pointer.itemId !== itemId) return;
    if (pointer.isPaused) return;
    this.room.setMyProgress(null);
    this.advanceIfOwner(pointer);
  }

  /**
   * The pointer's track has finished. Exactly one client may say so, and the
   * one that can is the client that queued the item: it is the only peer whose
   * `skip` is unambiguous. Everyone else waits for the snapshot.
   */
  private advanceIfOwner(pointer: PlaybackPointer): void {
    if (pointer.itemId === null) return;
    if (pointer.ownerPubkey !== this.room.myPubkey) return;
    if (this.skippedItemId === pointer.itemId) return;
    this.skippedItemId = pointer.itemId;
    this.room.skip();
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.endTimerItemId = null;
    this.endTimerAtEpochMs = null;
  }

  /**
   * Only correct drift against a player we have seen settle on our track and
   * actually make progress. Spotify reports position 0 while it buffers a
   * freshly started track; seeking then fights the load instead of the drift.
   */
  private shouldCorrectDrift(state: PlayerState, pointer: PlaybackPointer): boolean {
    if (state.trackUri !== pointer.uri) return false;
    return this.observedOnTrack && !state.isPaused && state.positionMs > 0;
  }

  /**
   * Spotify left our track for exactly the one we queued behind it: its own
   * gapless transition fired. The room follows it instead of racing it.
   */
  private transitionedToNext(state: PlayerState, pointer: PlaybackPointer): boolean {
    if (!this.observedOnTrack) return false;
    if (state.trackUri === pointer.uri) return false;
    const next = this.room.sessionQueue()[0]?.item.uri ?? null;
    return state.trackUri === next;
  }

  /**
   * Spotify moved into the track we queued behind ours, or parked paused at
   * the very end of ours. Both readings need `observedOnTrack`: before the
   * local player has ever reached this track, "not on it" means "has not
   * started yet".
   *
   * Moving to *any other* track is not an end. That is the user picking their
   * own music, and the control state turns it into a detach, not a skip.
   */
  private looksFinished(state: PlayerState, uri: string | null): boolean {
    if (!this.observedOnTrack) return false;
    if (state.trackUri !== uri) {
      const next = this.room.sessionQueue()[0]?.item.uri ?? null;
      return next !== null && state.trackUri === next;
    }
    return (
      state.isPaused &&
      state.durationMs > 0 &&
      state.positionMs >= state.durationMs - TRACK_END_SLACK_MS
    );
  }

  /**
   * The shared clock has run past the track's own length. Spotify sometimes
   * stops reporting a track end at all — this backstop treats the item as over
   * anyway, so the driver stops correcting drift against a finished track.
   */
  private ranPastDuration(state: PlayerState, pointer: PlaybackPointer, now: number): boolean {
    if (state.durationMs <= 0) return false;
    if (state.trackUri !== pointer.uri) return false;
    return now - pointer.startedAtEpochMs > state.durationMs + DURATION_OVERRUN_MS;
  }

  /** Spotify commands are best-effort; a failure is logged once, never thrown at the room. */
  private async tryInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.invoke<T>(cmd, args);
    } catch (error) {
      const message = `${cmd}: ${String(error)}`;
      if (!this.reportedErrors.has(message)) {
        this.reportedErrors.add(message);
        console.warn("spotjam: spotify command failed", message);
      }
      return null;
    }
  }
}
