// driver — the shell that reads Spotify, decides, and issues.
//
// Everything it decides is decided by the pure modules beside it. This file
// owns only the parts that touch the world: the timer, the bridge, the room
// subscription, and the Tauri commands.
//
// The loop is level-triggered. Every 150 ms it reads the player, computes what
// the room says the player should be doing, and commands the difference. Its
// only memory is the list of commands in flight. A change in Spotify that we
// did not command and the model does not predict is the user acting, and the
// driver detaches rather than fighting them for the player.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { PlaybackPointer, SessionEntry } from "@spotjam/protocol";
import { tauriBridgeState, type BridgeState, type BridgeStateSource } from "../bridge-state.js";
import { classify } from "./classify.js";
import type { Command } from "./commands.js";
import { desiredAt } from "./desired.js";
import {
  expectationFor,
  prune,
  rolloverFor,
  rolloverPending,
  type Expectation,
} from "./expectations.js";
import { nextMode, type Mode } from "./mode.js";
import { observationFrom, type ObserveResult, type Observation } from "./observation.js";
import { reconcile } from "./reconcile.js";
import { dropStuck, freshStuck, recordExpired, recordSuccess, stuckTargets } from "./stuck.js";

/** How often the player is read. Short: the gap it closes is audible. */
export const TICK_MS = 150;
/**
 * How close to the end of a track the transition is predicted.
 *
 * Wider than the slack the expectation itself allows, so the prediction is
 * registered before Spotify could plausibly act on it — including when the two
 * clocks disagree by a beat.
 */
export const ROLLOVER_WINDOW_MS = 2000;

/** What the driver needs of a room. `RoomClient` satisfies it structurally. */
export interface RoomView {
  getPlaybackPointer(): PlaybackPointer;
  sessionQueue(): SessionEntry[];
  /** Epoch ms in the server's clock, which is the clock the pointer is on. */
  serverNow(): number;
  onChange(cb: () => void): () => void;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The timer pair, injected so tests drive the loop with fake timers. */
export interface Timer {
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const realTimer: Timer = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class PlaybackDriver {
  private mode_: Mode = "attached";
  /** The last reading. Null means unobserved: there is nothing to compare against. */
  private prev: Observation | null = null;
  /** The commands in flight. The driver's only memory. */
  private outstanding: Expectation[] = [];
  /**
   * Bumped whenever what we know about the player stops being true: an attach,
   * a detach, the bridge going down. A tick that started before the bump must
   * not write what it read afterwards.
   */
  private generation = 0;
  private stuck = freshStuck();
  private lastStuck: string[] = [];
  /** The pointer item the stuck verdicts were reached against. */
  private lastItemId: string | null = null;
  /** The track a rollover has already been registered for. One per track. */
  private rolloverFrom: string | null = null;

  private bridgeState: BridgeState | null = null;
  private tickHandle: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeRoom: (() => void) | null = null;
  private unsubscribeBridge: (() => void) | null = null;

  /** A tick is running. One arriving during it sets `dirty` rather than overlapping. */
  private ticking = false;
  private dirty = false;
  private stopped = true;

  private readonly reportedErrors = new Set<string>();
  private readonly modeListeners = new Set<(mode: Mode) => void>();
  private readonly stuckListeners = new Set<(targets: string[]) => void>();

  constructor(
    private readonly room: RoomView,
    private readonly invoke: Invoke = tauriInvoke as Invoke,
    private readonly bridge: BridgeStateSource = tauriBridgeState,
    private readonly timer: Timer = realTimer,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Ticks do nothing until the bridge is ready, so the moment it becomes
    // ready is worth a tick at once: on a join that is the difference between
    // landing on the room's track now and waiting out a poll interval.
    this.unsubscribeBridge = this.bridge.subscribe((state) => {
      const became = state === "ready" && this.bridgeState !== "ready";
      this.bridgeState = state;
      if (became) void this.tick();
    });
    this.unsubscribeRoom = this.room.onChange(() => {
      void this.tick();
    });
    void this.tick();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.tickHandle !== null) this.timer.clearTimeout(this.tickHandle);
    this.tickHandle = null;
    this.unsubscribeRoom?.();
    this.unsubscribeRoom = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    // Anything we knew about the player describes the run that has just ended.
    // Keeping it would make the first tick after a restart blame the user for
    // a gap the stopped run never commanded — the stale-`prev` detach.
    this.forget();
    this.stuck = freshStuck();
    this.lastStuck = [];
    this.lastItemId = null;
  }

  mode(): Mode {
    return this.mode_;
  }

  /** Fires on every transition, and once with the current value on subscribe. */
  onModeChange(listener: (mode: Mode) => void): () => void {
    this.modeListeners.add(listener);
    listener(this.mode_);
    return () => {
      this.modeListeners.delete(listener);
    };
  }

  /** The targets Spotify would not take, for a chip to show. */
  onStuckChange(listener: (targets: string[]) => void): () => void {
    this.stuckListeners.add(listener);
    listener(this.lastStuck);
    return () => {
      this.stuckListeners.delete(listener);
    };
  }

  /**
   * Takes the player on the user's say-so, whatever it is doing.
   *
   * The reading we hold describes a player somebody else was driving, so it is
   * dropped: the next tick compares against nothing and blames nobody.
   */
  attach(): void {
    this.forget();
    this.stuck = freshStuck();
    this.publishStuck();
    this.setMode("attach");
    void this.tick();
  }

  detach(): void {
    this.forget();
    this.setMode("detach");
  }

  private setMode(event: Parameters<typeof nextMode>[1]): void {
    const next = nextMode(this.mode_, event);
    if (next === this.mode_) return;
    this.mode_ = next;
    console.debug("spotjam: playback", event, "->", next);
    for (const listener of [...this.modeListeners]) listener(next);
  }

  /** The 150 ms chain. A chain, not an interval: a slow tick never stacks. */
  private schedule(): void {
    if (this.stopped) return;
    if (this.tickHandle !== null) this.timer.clearTimeout(this.tickHandle);
    this.tickHandle = this.timer.setTimeout(() => {
      this.tickHandle = null;
      void this.tick().finally(() => this.schedule());
    }, TICK_MS);
  }

  /**
   * One pass, serialized. A tick arriving while one runs sets `dirty` and runs
   * after it: overlapping ticks would read a player the other tick's commands
   * have not reached yet.
   */
  private async tick(): Promise<void> {
    if (this.ticking) {
      this.dirty = true;
      return;
    }
    this.ticking = true;
    try {
      await this.runTick();
    } catch (error) {
      // One bad reading (malformed pointer, bad queue entry) must not become an
      // unhandled rejection on every `void this.tick()` call site, nor escape
      // through schedule()'s `.finally`. Report it; the loop keeps ticking.
      this.report("tick", error);
    } finally {
      this.ticking = false;
    }
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.tick();
    }
  }

  private async runTick(): Promise<void> {
    // A bridge that is not ready rejects every command, and the player it would
    // have described is not ours to reason about. Forgetting the last reading
    // is the point: when it comes back, the first tick compares against nothing
    // and corrects the player instead of blaming the user for the gap.
    if (this.bridgeState !== "ready") {
      this.forget();
      return;
    }

    // Reading Spotify is awaited, and `attach`, `detach` or the bridge going
    // down can all land during that await. Each of them declares the reading in
    // flight void: it describes a player under someone else's control, taken
    // before the decision that changed whose it is. Keeping it would let that
    // reading become the `prev` the next tick blames the user against.
    const generation = this.generation;
    const result = await this.observe();
    if (result === null || this.stopped || generation !== this.generation) return;
    const obs = observationFrom(result, this.now());

    // A track near its end gets its rollover registered before anything judges
    // or prunes, so the prediction is already in the list for the very reading
    // that first shows the transition.
    if (this.mode_ === "attached") this.watchForRollover(obs);

    // The list as it stood when the command was issued is what explains this
    // reading. An expectation is pruned exactly because the change it predicted
    // has now happened — which is the very change `classify` is about to judge,
    // so it has to see the expectation that accounts for it.
    const explaining = this.outstanding;
    const { kept, landed, expired } = prune(this.outstanding, obs, this.now());
    this.outstanding = kept;
    if (landed.length > 0 || expired.length > 0) {
      // A command that visibly landed proves its target works, whatever it did
      // before. One that ran out of time is a target we may give up on.
      // Rollovers are nobody's command and no target: a transition that did not
      // happen says nothing about whether a track can be played.
      this.stuck = recordExpired(
        recordSuccess(this.stuck, commandsOf(landed)),
        commandsOf(expired),
        this.now(),
      );
    }
    // Every tick, not only when the set is written: a verdict can also lapse
    // purely by getting old, and nothing else would notice.
    this.publishStuck();

    if (this.mode_ === "attached") await this.drive(obs, explaining, generation);
    // Issuing commands awaits too, so the check is made again: the reading is
    // only the new baseline if it still describes the run it was taken in.
    if (generation === this.generation) this.prev = obs;
  }

  /**
   * Predict the transition Spotify is about to make on its own.
   *
   * A track approaching its end will move by itself, and registering that
   * before it happens is what lets everything downstream treat it as ordinary:
   * `classify` sees a change something predicted, and `reconcile` sees a track
   * already on its way and does not start it a second time.
   *
   * One per track. The memo is what stops a fresh rollover being registered on
   * every tick of the last two seconds, and it clears when the player moves on
   * — the next track earns its own prediction when it reaches its own end.
   */
  private watchForRollover(obs: Observation): void {
    if (obs.trackUri !== this.rolloverFrom) this.rolloverFrom = null;
    if (this.rolloverFrom !== null) return;
    if (obs.isPaused || obs.durationMs <= 0) return;
    if (obs.positionMs < obs.durationMs - ROLLOVER_WINDOW_MS) return;
    if (rolloverPending(this.outstanding, obs.trackUri)) return;

    this.rolloverFrom = obs.trackUri;
    this.outstanding = [...this.outstanding, rolloverFor(obs, this.now())];
  }

  /**
   * Drop everything learnt about the player.
   *
   * The generation bump is what makes it stick: a tick already awaiting a
   * reading would otherwise land afterwards and restore exactly what was
   * dropped.
   */
  private forget(): void {
    this.prev = null;
    this.rolloverFrom = null;
    this.outstanding = [];
    this.generation += 1;
  }

  /**
   * Attached: blame first, then close the gap.
   *
   * The reading is judged against the previous one before anything is issued.
   * A user who has taken the player must not receive one more command on the
   * way out. `explaining` is the expectation list from before this reading
   * pruned it; `reconcile` uses the pruned one, because a landed command is no
   * longer a reason to hold back.
   */
  private async drive(
    obs: Observation,
    explaining: Expectation[],
    generation: number,
  ): Promise<void> {
    if (classify(this.prev, obs, explaining) === "user") {
      this.outstanding = [];
      this.setMode("user-took-player");
      return;
    }

    const pointer = this.room.getPlaybackPointer();
    // A new item is a fresh start for the player. Verdicts about what Spotify
    // would not take were reached against the item that has just gone: the same
    // track queued again deserves its own attempt, not the last one's silence.
    if (pointer.itemId !== this.lastItemId) {
      this.lastItemId = pointer.itemId;
      this.stuck = freshStuck();
      this.publishStuck();
    }

    const desired = desiredAt(pointer, this.room.sessionQueue(), this.room.serverNow());
    // The stuck set goes in rather than filtering what comes out: a play we
    // have given up on takes its seek and its pause with it, and only reconcile
    // knows they were one group.
    const commands = dropStuck(
      this.stuck,
      reconcile(desired, obs, this.outstanding, this.stuck, this.now()),
      this.now(),
    );
    for (const command of commands) {
      if (this.stopped || this.mode_ !== "attached" || generation !== this.generation) return;
      if (!(await this.send(command))) continue;
      // The send awaited: a detach/attach (→ forget, generation bump) can have
      // landed during it. Appending anyway would hang the just-sent command's
      // expectation on the fresh run, suppressing reconcile for its lifetime.
      if (this.stopped || this.mode_ !== "attached" || generation !== this.generation) return;
      this.outstanding = [...this.outstanding, expectationFor(command, this.now())];
    }
  }

  /** One reading of the player. Null when the bridge refused; the caller keeps `prev`. */
  private async observe(): Promise<ObserveResult | null> {
    try {
      return await this.invoke<ObserveResult>("spotify_observe");
    } catch (error) {
      this.report("spotify_observe", error);
      return null;
    }
  }

  /** One command. False when the bridge refused it, so it never reached Spotify. */
  private async send(command: Command): Promise<boolean> {
    const [cmd, args] = tauriCall(command);
    try {
      await this.invoke(cmd, args);
      return true;
    } catch (error) {
      this.report(cmd, error);
      return false;
    }
  }

  private publishStuck(): void {
    const targets = stuckTargets(this.stuck, this.now());
    if (targets.length === this.lastStuck.length && targets.every((t, i) => t === this.lastStuck[i]))
      return;
    this.lastStuck = targets;
    for (const listener of [...this.stuckListeners]) listener(targets);
  }

  /** One line per distinct failure, however many times it happens. */
  private report(cmd: string, error: unknown): void {
    const message = `${cmd}: ${String(error)}`;
    if (this.reportedErrors.has(message)) return;
    this.reportedErrors.add(message);
    console.warn("spotjam: spotify command failed", message);
  }
}

/**
 * The commands among these expectations.
 *
 * A rollover is not one: nothing was sent, so there is nothing to judge a
 * target by. Dropping them here keeps the stuck bookkeeping about commands.
 */
function commandsOf(list: Expectation[]): Command[] {
  return list.flatMap((e) => (e.what.kind === "rollover" ? [] : [e.what]));
}

/** The bridge command and arguments one command travels as. */
function tauriCall(command: Command): [string, Record<string, unknown> | undefined] {
  switch (command.kind) {
    case "play":
      return ["spotify_play_track", { uri: command.uri }];
    case "seek":
      // positionMs arrives interpolated from the room clock and can be
      // fractional; the Tauri bridge declares u64 and rejects a float.
      return ["spotify_seek", { positionMs: Math.round(command.positionMs) }];
    case "pause":
      return ["spotify_pause", undefined];
    case "resume":
      return ["spotify_resume", undefined];
    case "set-next":
      return ["spotify_set_next_track", { uri: command.uri }];
    case "clear-queue":
      return ["spotify_clear_queue", undefined];
  }
}
