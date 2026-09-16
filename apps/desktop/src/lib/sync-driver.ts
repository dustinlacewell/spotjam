import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { PlaybackPointer, Room } from "./room";
import { positionMs } from "./playback-clock";
import { nextControlState, type ControlState, type LocalPlayback } from "./control-state";

export type { ControlState } from "./control-state";
import { tauriBridgeState, type BridgeState, type BridgeStateSource } from "./bridge-state";
import { freshMemo, reconcile, type Command, type Desired, type Memo } from "./reconcile";

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
/**
 * How long the player is left alone after we report an end, waiting for the
 * server's new pointer. It covers one round trip. A server that never answers
 * must not hold the player forever: past this the usual reading applies and a
 * user who has moved Spotify gets it back.
 */
const END_GRACE_MS = 10_000;
/**
 * How long a reading whose position runs past its own duration is treated as
 * Spotify not having caught up yet. It reports a new track's uri a beat before
 * its length; a beat is not ten seconds, so a reading that stays inconsistent
 * this long is the player's real state.
 */
const STALE_DURATION_MS = 10_000;

export interface PlayerState {
  trackUri: string | null;
  trackName: string | null;
  isPaused: boolean;
  positionMs: number;
  durationMs: number;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** What a player that could not be read counts as: on nothing, playing nothing. */
const UNREADABLE_PLAYER: PlayerState = {
  trackUri: null,
  trackName: null,
  isPaused: false,
  positionMs: 0,
  durationMs: 0,
};

/** Keeping Spotify's one-slot queue right is worth doing even on a finished track. */
function isQueueCommand(command: Command): boolean {
  return command.kind === "set-next" || command.kind === "clear-queue";
}

/**
 * Wires a joined room to the local Spotify client: plays whatever the shared
 * playback pointer names, seeks to the position the shared clock implies, and
 * mirrors pause/resume.
 *
 * It is level-triggered. Every tick reads what Spotify actually does, compares
 * it with what the room says, and issues the commands that close the gap. It
 * remembers nothing about what it applied, so a command that never landed —
 * the bridge was down, Spotify was busy — is simply issued again on the next
 * tick. `reconcile` holds that comparison as a pure function; this class is the
 * shell that reads, issues, and reports.
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
  /** Do we drive the local player? Null until the first evaluation. */
  private control: ControlState | null = null;
  /** The pointer item the control state was last evaluated against. */
  private lastPointerItemId: string | null = null;
  /** The rate limits on play and seek, handed to and returned by `reconcile`. */
  private memo: Memo = freshMemo();
  /** Fires shortly after the pointer's track runs out, so the poll loop settles. */
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  /** The item the pending end timer was scheduled for. */
  private endTimerItemId: string | null = null;
  /** The instant the pending end timer is aimed at, so an unchanged end is not rescheduled. */
  private endTimerAtEpochMs: number | null = null;
  /**
   * True once a read has actually seen Spotify playing the pointer's track.
   * Until then "Spotify is on some other track" means our play command has
   * not landed yet, not that the track finished.
   */
  private observedOnTrack = false;
  /**
   * The item we have already reported as finished. Four detectors can see the
   * same end; this makes sure only the first one sends `skip`.
   */
  private skippedItemId: string | null = null;
  /**
   * The item this client has seen end, whoever owns it. Between that reading
   * and the server's new pointer the player sits on a track the pointer does
   * not name, and control must not read that as the user taking over.
   */
  private endedItemId: string | null = null;
  /**
   * When that end was seen. The grace it buys lasts a round trip, not forever:
   * a server that never answers must not leave us driving over a user who has
   * taken the player back.
   */
  private endedAtEpochMs = 0;
  /**
   * When the current item's reading first showed a position past its own
   * duration. A beat of that is Spotify catching up; a long run of it is a
   * player that really has run past the track.
   */
  private overranSinceEpochMs: number | null = null;
  /** The bridge's last reported state. Ticks are skipped unless it is ready. */
  private bridgeState: BridgeState | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private unsubscribeChange: (() => void) | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  /** A tick is running. A change during it sets `dirty` instead of overlapping. */
  private ticking = false;
  private dirty = false;
  /** `stop()` has been called. A tick still in flight writes nothing more. */
  private stopped = false;
  private readonly reportedErrors = new Set<string>();
  /** Who wants to hear about control changes. The UI reads the state from here. */
  private readonly controlListeners = new Set<(control: ControlState) => void>();

  constructor(
    private readonly room: Room,
    private readonly invoke: Invoke = tauriInvoke as Invoke,
    private readonly bridge: BridgeStateSource = tauriBridgeState,
  ) {}

  start(): void {
    // A driver that was stopped and started again drives the player again.
    this.stopped = false;
    // Ticks are gated on the bridge being ready, so the moment it becomes ready
    // is a tick worth running at once: on a join that is the difference between
    // landing on the room's track now and waiting out a poll interval.
    this.unsubscribeBridge = this.bridge.subscribe((state) => {
      const became = state === "ready" && this.bridgeState !== "ready";
      this.bridgeState = state;
      if (became) void this.tick();
    });
    this.unsubscribeChange = this.room.onChange(() => {
      void this.tick();
    });
    void this.tick();
    this.pollHandle = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Tells the UI when control changes. Fires on every transition, and once with
   * the current value on subscribe.
   */
  onControlChange(listener: (control: ControlState) => void): () => void {
    this.controlListeners.add(listener);
    listener(this.control ?? "idle");
    return () => {
      this.controlListeners.delete(listener);
    };
  }

  /**
   * Attaches to the local player on the user's say-so, whatever it is doing.
   * The control decision restarts as if the room were just joined, and the
   * rate limits are dropped so the pointer's track is played at once.
   */
  sync(): void {
    this.control = null;
    this.memo = freshMemo();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.clearEndTimer();
    this.unsubscribeChange?.();
    this.unsubscribeChange = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
  }

  /**
   * One pass: read the player, close the gap with the room, then report
   * progress and watch for the end of the track.
   *
   * A tick that arrives while one is running sets `dirty`, and one more runs
   * after the current one finishes. Overlapping ticks would read a player that
   * the other tick's commands have not reached yet.
   */
  private async tick(now = Date.now()): Promise<void> {
    if (this.ticking) {
      this.dirty = true;
      return;
    }
    this.ticking = true;
    try {
      await this.runTick(now);
    } finally {
      this.ticking = false;
    }
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.tick();
    }
  }

  private async runTick(now: number): Promise<void> {
    // A bridge that is known not to be ready rejects every command. Skipping
    // the tick keeps the log quiet; the next one corrects the player once it is
    // back.
    //
    // A bridge that has said nothing yet is driven anyway. It is the weaker of
    // two risks: a few refused commands at the join, against a driver that
    // never touches the player at all if the state never arrives. Commands the
    // bridge refuses are not remembered as issued, so the next tick retries.
    if (this.bridgeState !== null && this.bridgeState !== "ready") return;

    const { state, pointer, nextUri } = await this.evaluateControl(now);
    // The user left the room while we were reading Spotify. Nothing after this
    // point has anywhere to go: the room is done with and the player is theirs.
    if (this.stopped) return;

    if (pointer.itemId === null) {
      this.room.setMyProgress(null);
      return;
    }
    if (!this.following) return;
    const uri = pointer.uri;
    if (!uri) return;

    // A player we cannot read is a player on no track: the room's track is
    // started, which is what an unreadable player needs anyway.
    const actualState = state ?? UNREADABLE_PLAYER;
    // The end is decided before the player is corrected. An item that is over
    // is the server's to replace; correcting the player against it would drag
    // Spotify back onto a track that just finished.
    const over = pointer.isPaused ? false : this.watchForTheEnd(actualState, pointer, nextUri, now);

    const queueHead = await this.readQueueHead();
    if (this.stopped) return;
    const desired = this.desiredFrom(uri, pointer, nextUri, now);
    const result = reconcile(desired, { state: actualState, queueHead }, this.memo, now);
    // Only the queue slot is still worth keeping right on a finished item.
    const delivered = await this.issue(
      over ? result.commands.filter(isQueueCommand) : result.commands,
    );
    // The rate limits only stand for commands Spotify actually received. One
    // the bridge refused leaves the driver exactly where it was, free to try
    // again on the next tick rather than waiting out a grace for nothing.
    this.memo = delivered ? result.memo : this.memo;
  }

  /** What the room says the local player should be doing right now. */
  private desiredFrom(
    uri: string,
    pointer: PlaybackPointer,
    nextUri: string | null,
    now: number,
  ): Desired {
    return {
      uri,
      positionMs: positionMs(pointer, now),
      isPaused: pointer.isPaused,
      nextUri,
    };
  }

  private nextUri(): string | null {
    return this.room.sessionQueue()[0]?.item.uri ?? null;
  }

  /** The head of Spotify's own queue, or null when it is empty or unreadable. */
  private async readQueueHead(): Promise<string | null> {
    const queue = await this.tryInvoke<string[]>("spotify_get_queue");
    return queue?.[0] ?? null;
  }

  /**
   * Hands each command to the Rust bridge, in the order reconcile put them,
   * and answers whether they all landed.
   *
   * A command the bridge refused did not happen. The rate limits exist to stop
   * us re-issuing something Spotify is still working on — but a command that
   * never reached Spotify is not being worked on, and remembering it as issued
   * leaves the driver believing it has already played a track it has not. It
   * then waits out the grace against a player that never moved.
   */
  private async issue(commands: Command[]): Promise<boolean> {
    let delivered = true;
    for (const command of commands) {
      if (this.stopped) return false;
      switch (command.kind) {
        case "play":
          delivered = (await this.send("spotify_play_track", { uri: command.uri })) && delivered;
          break;
        case "seek":
          delivered =
            (await this.send("spotify_seek", { positionMs: command.positionMs })) && delivered;
          break;
        case "pause":
          delivered = (await this.send("spotify_pause")) && delivered;
          break;
        case "resume":
          delivered = (await this.send("spotify_resume")) && delivered;
          break;
        case "set-next":
          delivered =
            (await this.send("spotify_set_next_track", { uri: command.uri })) && delivered;
          break;
        case "clear-queue":
          delivered = (await this.send("spotify_clear_queue")) && delivered;
          break;
      }
    }
    return delivered;
  }

  /** One command. False when the bridge refused it, so it never reached Spotify. */
  private async send(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
    try {
      await this.invoke(cmd, args);
      return true;
    } catch (error) {
      this.report(cmd, error);
      return false;
    }
  }

  /**
   * Re-decides whether we drive the local player, and answers with the player
   * state and the pointer it decided against. Reading Spotify is best-effort: a
   * failed read is a null `LocalPlayback`, which the decision treats as "no
   * reason to let go".
   *
   * The pointer and the session queue head come back with the answer because
   * reading Spotify is awaited, and a snapshot can land while that await is in
   * flight. A caller that read either again afterwards would act on a different
   * room than the one the control decision — and `observedOnTrack`, and the
   * rate limits — were reset for: it would read the track that just ended as
   * the new item's own end, or read Spotify's own gapless move into the head it
   * just judged as the user taking the player. One read, one tick.
   *
   * A pointer that moves to a new item is a fresh target: the rate limits and
   * the end bookkeeping start over.
   */
  private async evaluateControl(now: number): Promise<{
    state: PlayerState | null;
    pointer: PlaybackPointer;
    nextUri: string | null;
  }> {
    const pointer = this.room.getPlaybackPointer();
    const nextUri = this.nextUri();
    const changed = pointer.itemId !== this.lastPointerItemId;
    if (changed) this.onNewItem(pointer);
    this.lastPointerItemId = pointer.itemId;

    const state = await this.tryInvoke<PlayerState>("spotify_get_state");
    const local: LocalPlayback | null = state
      ? { trackUri: state.trackUri, isPaused: state.isPaused }
      : null;

    const prev = this.control;
    const endReported =
      this.endedItemId !== null &&
      this.endedItemId === pointer.itemId &&
      now - this.endedAtEpochMs < END_GRACE_MS;
    const control = nextControlState(prev, local, pointer, nextUri, changed, endReported);
    this.control = control;
    if (control !== prev) {
      console.debug("spotjam: control", prev ?? "(none)", "->", control);
      for (const listener of [...this.controlListeners]) listener(control);
    }
    return { state, pointer, nextUri };
  }

  /** The pointer moved to a different item: nothing learnt about the old one holds. */
  private onNewItem(pointer: PlaybackPointer): void {
    this.observedOnTrack = false;
    this.memo = freshMemo();
    this.clearEndTimer();
    if (pointer.itemId !== this.skippedItemId) this.skippedItemId = null;
    if (pointer.itemId !== this.endedItemId) this.endedItemId = null;
    this.overranSinceEpochMs = null;
  }

  private get following(): boolean {
    return this.control === "following";
  }

  /**
   * Report where the local player sits, and decide whether the track is over.
   *
   * Four readings say "over": Spotify moved into the track we queued behind
   * this one, it parked paused at the very end, the shared clock ran past the
   * track's own length, or the fallback timer fired. The first one wins and the
   * item's owner sends `skip`. Answers whether the item is over, so the caller
   * knows not to correct the player against a track that has finished.
   */
  private watchForTheEnd(
    state: PlayerState,
    pointer: PlaybackPointer,
    nextUri: string | null,
    now: number,
  ): boolean {
    if (this.transitionedToNext(state, pointer, nextUri)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer, now);
      return true;
    }

    // An item we have already called over gets no more progress. Spotify may
    // still sit on its track — parked at the end, or wedged there — and
    // broadcasting that to the room puts a live progress bar on a track that
    // finished, for every listener, until the pointer moves.
    const alreadyEnded = this.endedItemId !== null && this.endedItemId === pointer.itemId;
    if (state.trackUri === pointer.uri && pointer.itemId !== null) {
      this.observedOnTrack = true;
      if (!alreadyEnded) {
        this.room.setMyProgress({
          itemId: pointer.itemId,
          positionMs: state.positionMs,
          durationMs: state.durationMs,
          sampledAtEpochMs: now,
        });
      }
      if (!alreadyEnded && this.durationIsThisTrack(state, now)) {
        this.scheduleEndTimer(
          pointer,
          pointer.startedAtEpochMs + state.durationMs + TRACK_END_FALLBACK_MS,
          now,
        );
      }
    }

    const playedLongEnough = now - pointer.startedAtEpochMs > TRACK_END_GRACE_MS;
    if (playedLongEnough && this.looksFinished(state, pointer.uri, nextUri)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer, now);
      return true;
    }

    if (this.ranPastDuration(state, pointer, now)) {
      this.clearEndTimer();
      this.advanceIfOwner(pointer, now);
      return true;
    }
    return false;
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
  private advanceIfOwner(pointer: PlaybackPointer, now = Date.now()): void {
    if (pointer.itemId === null) return;
    // Stamped once per item. A detector that keeps firing — a player parked at
    // the end of its track — must not keep pushing the grace window forward,
    // or the bound it puts on driving over the user never arrives.
    if (this.endedItemId !== pointer.itemId) {
      this.endedItemId = pointer.itemId;
      this.endedAtEpochMs = now;
    }
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
   * Spotify left our track for exactly the one we queued behind it: its own
   * gapless transition fired. The room follows it instead of racing it.
   */
  private transitionedToNext(
    state: PlayerState,
    pointer: PlaybackPointer,
    nextUri: string | null,
  ): boolean {
    if (!this.observedOnTrack) return false;
    if (state.trackUri === pointer.uri) return false;
    return nextUri !== null && state.trackUri === nextUri;
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
  private looksFinished(state: PlayerState, uri: string | null, nextUri: string | null): boolean {
    if (!this.observedOnTrack) return false;
    if (state.trackUri !== uri) {
      return nextUri !== null && state.trackUri === nextUri;
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
   *
   */
  private ranPastDuration(state: PlayerState, pointer: PlaybackPointer, now: number): boolean {
    if (!this.durationIsThisTrack(state, now)) return false;
    if (state.trackUri !== pointer.uri) return false;
    return now - pointer.startedAtEpochMs > state.durationMs + DURATION_OVERRUN_MS;
  }

  /**
   * Is the length in this reading the length of the track it names?
   *
   * Spotify reports a new track's uri a beat before its duration, so a reading
   * can carry the uri we want against the previous track's length. A short
   * stale length is then read as an end at once — an immediate false skip, and
   * the room advances under everyone. The player's own position tells the two
   * apart: it never runs past a real length, and it sits far past a stale one.
   *
   * Only for a beat, though. The doubt has to expire: a player really can park
   * past the end of its track, and disbelieving its length forever leaves both
   * end detectors off — the item never finishes and the room wedges on it.
   */
  private durationIsThisTrack(state: PlayerState, now: number): boolean {
    if (state.durationMs <= 0) return false;
    if (state.positionMs <= state.durationMs + DURATION_OVERRUN_MS) {
      this.overranSinceEpochMs = null;
      return true;
    }
    this.overranSinceEpochMs ??= now;
    return now - this.overranSinceEpochMs >= STALE_DURATION_MS;
  }

  /** Spotify reads are best-effort; a failure is logged once, never thrown at the room. */
  private async tryInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.invoke<T>(cmd, args);
    } catch (error) {
      this.report(cmd, error);
      return null;
    }
  }

  /** One line per distinct failure, however many times it happens. */
  private report(cmd: string, error: unknown): void {
    const message = `${cmd}: ${String(error)}`;
    if (this.reportedErrors.has(message)) return;
    this.reportedErrors.add(message);
    console.warn("spotjam: spotify command failed", message);
  }
}
