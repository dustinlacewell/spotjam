import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NULL_POINTER, type PlaybackPointer, type SessionEntry } from "@spotjam/protocol";
import type { BridgeState, BridgeStateSource } from "../bridge-state";
import { PlaybackDriver, TICK_MS, type RoomView, type Timer } from "./driver";
import type { ObserveResult } from "./observation";
import { STUCK_TTL_MS } from "./stuck";

const A = "spotify:track:a";
const B = "spotify:track:b";
const C = "spotify:track:c";
const AD = "spotify:ad:1";
const TRACK_MS = 200_000;

/**
 * A Spotify that obeys late, the way the real one does: a play shows up after
 * 800 ms, a seek after 300, a pause or resume after 100. Until then it reports
 * exactly what it reported before.
 */
class FakeSpotify {
  trackUri: string | null = null;
  isPaused = true;
  positionMs = 0;
  durationMs = 0;
  queueHead: string | null = null;
  /** A track the client will never start, however often it is asked. */
  unplayable: string | null = null;
  /** Hold the position still, the way a track still buffering does. */
  frozen = false;
  /** Drop any seek that arrives while the player is still playing. */
  dropSeekWhilePlaying = false;
  /** How long the tracks this client loads turn out to be. */
  trackDurationMs = TRACK_MS;

  private lastAt = 0;
  private effects: { at: number; apply: () => void }[] = [];
  readonly calls: { cmd: string; args?: Record<string, unknown> }[] = [];

  /** Advances the model's own clock to `now`, applying whatever has come due. */
  advance(now: number): void {
    const playing = !this.isPaused && this.trackUri !== null && !this.frozen;
    if (playing) this.positionMs = Math.min(this.durationMs, this.positionMs + (now - this.lastAt));
    this.lastAt = now;
    const due = this.effects.filter((e) => e.at <= now);
    this.effects = this.effects.filter((e) => e.at > now);
    for (const effect of due) effect.apply();
  }

  observe(now: number): ObserveResult {
    this.advance(now);
    return {
      state: {
        trackUri: this.trackUri,
        trackName: this.trackUri,
        isPaused: this.isPaused,
        positionMs: this.positionMs,
        durationMs: this.durationMs,
      },
      queueHead: this.queueHead,
    };
  }

  invoke(cmd: string, args: Record<string, unknown> | undefined, now: number): void {
    this.advance(now);
    this.calls.push({ cmd, args });
    switch (cmd) {
      case "spotify_play_track": {
        const uri = args?.uri as string;
        if (uri === this.unplayable) return;
        this.after(now, 800, () => {
          this.trackUri = uri;
          this.isPaused = false;
          this.positionMs = 0;
          this.durationMs = this.trackDurationMs;
          // Starting a track consumes whatever sat in the one-slot queue.
          if (this.queueHead === uri) this.queueHead = null;
        });
        return;
      }
      case "spotify_seek": {
        const positionMs = args?.positionMs as number;
        this.after(now, 300, () => {
          // A seek with nothing loaded has nothing to move.
          if (this.trackUri === null) return;
          if (this.dropSeekWhilePlaying && !this.isPaused) return;
          this.positionMs = positionMs;
        });
        return;
      }
      case "spotify_pause":
        this.after(now, 100, () => {
          this.isPaused = true;
        });
        return;
      case "spotify_resume":
        this.after(now, 100, () => {
          this.isPaused = false;
        });
        return;
      case "spotify_set_next_track":
        this.after(now, 50, () => {
          this.queueHead = args?.uri as string;
        });
        return;
      case "spotify_clear_queue":
        this.after(now, 50, () => {
          this.queueHead = null;
        });
        return;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }

  /** The user reaching for the keyboard: an immediate change nobody commanded. */
  userPlays(uri: string): void {
    this.trackUri = uri;
    this.isPaused = false;
    this.positionMs = 0;
    this.durationMs = this.trackDurationMs;
  }

  /** Spotify's own gapless step into the track sitting in its queue slot. */
  runOutIntoQueue(): void {
    this.positionMs = this.durationMs;
    const next = this.queueHead;
    if (next === null) {
      this.isPaused = true;
      return;
    }
    this.trackUri = next;
    this.queueHead = null;
    this.positionMs = 0;
    this.durationMs = this.trackDurationMs;
  }

  private after(now: number, ms: number, apply: () => void): void {
    this.effects.push({ at: now + ms, apply });
  }

  playsOf(uri?: string): { cmd: string; args?: Record<string, unknown> }[] {
    return this.calls.filter(
      (c) => c.cmd === "spotify_play_track" && (uri === undefined || c.args?.uri === uri),
    );
  }
}

/** A room whose pointer and queue the test sets, the way the server would. */
class FakeRoom implements RoomView {
  pointer: PlaybackPointer = NULL_POINTER;
  queue: SessionEntry[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly clock: () => number) {}

  getPlaybackPointer(): PlaybackPointer {
    return this.pointer;
  }
  sessionQueue(): SessionEntry[] {
    return this.queue;
  }
  serverNow(): number {
    return this.clock();
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** A snapshot landing: set the state, then tell whoever is listening. */
  update(over: { pointer?: PlaybackPointer; queue?: SessionEntry[] }): void {
    if (over.pointer) this.pointer = over.pointer;
    if (over.queue) this.queue = over.queue;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeBridge implements BridgeStateSource {
  private state: BridgeState = "ready";
  private readonly listeners = new Set<(s: BridgeState) => void>();
  subscribe(listener: (s: BridgeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  connect(): Promise<BridgeState> {
    return Promise.resolve(this.state);
  }
  set(state: BridgeState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

function entry(uri: string, id = uri, durationMs = TRACK_MS): SessionEntry {
  return {
    item: { id, uri, trackId: id, durationMs },
    ownerPubkey: "aa",
    ownerName: "someone",
  };
}

function pointerOn(uri: string, startedAtEpochMs: number, over: Partial<PlaybackPointer> = {}) {
  return {
    itemId: uri,
    ownerPubkey: "aa",
    uri,
    startedAtEpochMs,
    isPaused: false,
    pausedAtOffsetMs: 0,
    durationMs: TRACK_MS,
    ...over,
  } satisfies PlaybackPointer;
}

/** The whole rig: fake clock, fake Spotify, fake room, fake bridge, real driver. */
function setup(bridgeState: BridgeState = "ready") {
  const spotify = new FakeSpotify();
  const bridge = new FakeBridge();
  if (bridgeState !== "ready") bridge.set(bridgeState);
  const now = () => Date.now();
  const room = new FakeRoom(now);

  const invoke = vi.fn(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd === "spotify_observe") return spotify.observe(now()) as T;
    spotify.invoke(cmd, args, now());
    return undefined as T;
  });

  const timer: Timer = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const driver = new PlaybackDriver(room, invoke as never, bridge, timer, now);
  return { spotify, bridge, room, driver, invoke };
}

/** Runs the loop for `ms` of fake time, letting each tick's promises settle. */
async function run(ms: number): Promise<void> {
  const ticks = Math.ceil(ms / TICK_MS);
  for (let i = 0; i < ticks; i += 1) {
    await vi.advanceTimersByTimeAsync(TICK_MS);
  }
}

describe("PlaybackDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("joins a room and plays the pointer's track at the right offset", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now() - 30_000);
    room.queue = [entry(B)];

    driver.start();
    // The play lands at 800ms and the seek follows within a tick or two of the
    // first non-zero position it reports — no waiting out a lost seek.
    await run(2000);

    expect(spotify.trackUri).toBe(A);
    expect(spotify.isPaused).toBe(false);
    // Started 30s ago, and the fake clock has run a little further since.
    expect(spotify.positionMs).toBeGreaterThanOrEqual(30_000);
    expect(spotify.positionMs).toBeLessThan(35_000);
    expect(spotify.queueHead).toBe(B);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("seeks within a tick of the first real position Spotify reports", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now() - 60_000);
    driver.start();

    // The play lands at 800ms; the model reports a real position from the tick
    // after that. The seek must follow it closely, not wait out an expectation.
    await run(1200);
    const seekAt = spotify.calls.findIndex((c) => c.cmd === "spotify_seek");
    expect(seekAt).toBeGreaterThanOrEqual(0);
    // Nothing but the play precedes it: no seek was thrown at a missing track.
    expect(spotify.calls.slice(0, seekAt).map((c) => c.cmd)).toEqual(["spotify_play_track"]);

    await run(1000);
    expect(spotify.positionMs).toBeGreaterThanOrEqual(60_000);
    expect(spotify.positionMs).toBeLessThan(65_000);
    driver.stop();
  });

  it("issues no seek while the track is still loading", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now() - 60_000);
    driver.start();

    // Before the play lands there is no track to place.
    await run(600);
    expect(spotify.calls.map((c) => c.cmd)).toEqual(["spotify_play_track"]);
    driver.stop();
  });

  it("sends the bridge integer seek positions even with a fractional server clock", async () => {
    // The room clock interpolates offsets and can hand the driver a fractional
    // serverNow, making the seek position a float. The Tauri bridge declares
    // u64 and rejects the command outright — so the bridge call must round.
    const { spotify, room, driver } = setup();
    // The live failure arrived from a serverNow with a sub-millisecond tail.
    (room as unknown as { clock: () => number }).clock = () => Date.now() + 0.044189453125;
    room.pointer = pointerOn(A, Date.now() - 60_000);
    driver.start();
    await run(1500);

    const seeks = spotify.calls.filter((c) => c.cmd === "spotify_seek");
    expect(seeks.length).toBeGreaterThan(0);
    for (const call of seeks) {
      expect(Number.isInteger(call.args?.positionMs as number)).toBe(true);
    }
    driver.stop();
  });

  it("pauses before seeking when joining a paused room mid-track", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now(), {
      isPaused: true,
      pausedAtOffsetMs: 60_000,
    });
    driver.start();
    await run(3000);

    const kinds = spotify.calls.map((c) => c.cmd);
    expect(kinds[0]).toBe("spotify_play_track");
    // The pause lands before the seek, so the track never audibly runs on at
    // the wrong offset while the seek is in flight.
    expect(kinds.indexOf("spotify_pause")).toBeGreaterThan(-1);
    expect(kinds.indexOf("spotify_pause")).toBeLessThan(kinds.indexOf("spotify_seek"));

    expect(spotify.isPaused).toBe(true);
    expect(spotify.positionMs).toBe(60_000);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("seeks a paused room the moment somebody moves it", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now(), { isPaused: true, pausedAtOffsetMs: 60_000 });
    driver.start();
    await run(4000);
    expect(spotify.isPaused).toBe(true);
    expect(spotify.positionMs).toBe(60_000);

    // Somebody in the room drags the paused track back to 20s.
    room.update({
      pointer: pointerOn(A, Date.now(), { isPaused: true, pausedAtOffsetMs: 20_000 }),
    });
    await run(1000);

    expect(spotify.positionMs).toBe(20_000);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("recovers when the seek for a paused join is dropped", async () => {
    const { spotify, room, driver } = setup();
    // This client drops any seek issued while the player is still playing —
    // the window between the play landing and the pause taking effect.
    spotify.dropSeekWhilePlaying = true;
    room.pointer = pointerOn(A, Date.now(), { isPaused: true, pausedAtOffsetMs: 60_000 });
    driver.start();
    await run(8000);

    // The drift branch retries once the player reports paused, so the lost
    // seek is not lost for good.
    expect(spotify.isPaused).toBe(true);
    expect(spotify.positionMs).toBe(60_000);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("plays the next track only once when our clock leads Spotify's", async () => {
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt);
    room.queue = [entry(B)];
    driver.start();
    await run(4000);
    expect(spotify.queueHead).toBe(B);

    // Our clock crosses the end 500ms before Spotify's own transition fires.
    // Playing B ourselves here would start it, and Spotify would start it again.
    await vi.advanceTimersByTimeAsync(TRACK_MS - (Date.now() - startedAt) + 500);
    expect(spotify.trackUri).toBe(A);
    await run(TICK_MS * 2);
    // The slot still holds B: emptying it would cost us the seamless step.
    expect(spotify.queueHead).toBe(B);

    spotify.runOutIntoQueue();
    await run(2000);

    expect(spotify.trackUri).toBe(B);
    expect(spotify.playsOf(B)).toHaveLength(0);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("tries a re-queued copy of a track it had given up on", async () => {
    const { spotify, room, driver } = setup();
    spotify.unplayable = A;
    room.pointer = pointerOn(A, Date.now(), { itemId: "first" });
    driver.start();
    await run(60_000);
    expect(spotify.playsOf(A)).toHaveLength(5);

    // The same track, queued again: a new item, and a fresh chance.
    room.update({ pointer: pointerOn(A, Date.now(), { itemId: "second" }) });
    await run(2000);

    expect(spotify.playsOf(A).length).toBeGreaterThan(5);
    driver.stop();
  });

  it("tries a stuck track again once the verdict has aged out", async () => {
    const { spotify, room, driver } = setup();
    spotify.unplayable = A;
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(60_000);
    expect(spotify.playsOf(A)).toHaveLength(5);

    // A verdict is not a life sentence: past its lifetime the track is worth
    // one more attempt, in case whatever blocked it has passed.
    await run(STUCK_TTL_MS + 2000);

    expect(spotify.playsOf(A).length).toBeGreaterThan(5);
    driver.stop();
  });

  it("plays only once while the play is still landing", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(3000);

    expect(spotify.playsOf(A)).toHaveLength(1);
    driver.stop();
  });

  it("follows Spotify's own gapless move into the queued track, without detaching", async () => {
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt);
    room.queue = [entry(B)];
    driver.start();
    await run(2000);
    expect(spotify.queueHead).toBe(B);
    const playsBefore = spotify.playsOf().length;

    // The track runs out and Spotify steps into the queued one by itself, at
    // the instant the shared clock says it should.
    await vi.advanceTimersByTimeAsync(TRACK_MS - (Date.now() - startedAt));
    spotify.runOutIntoQueue();
    expect(spotify.trackUri).toBe(B);

    // The server's new snapshot lands 200 ms after the end.
    await run(200);
    room.update({ pointer: pointerOn(B, startedAt + TRACK_MS), queue: [] });
    await run(2000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(B);
    // Spotify was already on the right track: nothing was played again.
    expect(spotify.playsOf().length).toBe(playsBefore);
    driver.stop();
  });

  it("does not detach when Spotify moves into the queued track a tick early", async () => {
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt);
    room.queue = [entry(B)];
    driver.start();
    await run(2000);
    expect(spotify.queueHead).toBe(B);

    // Spotify's own clock is a beat ahead of the room's: it steps into the
    // queued track just before the shared clock calls the track over.
    await vi.advanceTimersByTimeAsync(TRACK_MS - (Date.now() - startedAt) - TICK_MS);
    spotify.runOutIntoQueue();
    await run(TICK_MS * 2);

    // Following Spotify's own transition is never the user acting.
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("plays the next track itself when Spotify did not move", async () => {
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt);
    room.queue = [entry(B)];
    driver.start();
    await run(2000);

    // Run up to the end with the driver watching, so the rollover is
    // registered, then let the track stop dead instead of moving on.
    await vi.advanceTimersByTimeAsync(TRACK_MS - (Date.now() - startedAt) - 3000);
    await run(3000);
    spotify.isPaused = true;
    room.update({ pointer: pointerOn(B, startedAt + TRACK_MS), queue: [] });

    // The rollover expires about 1.5s past the track's own end; only then is
    // the transition declared not to be coming, and we start B ourselves.
    await run(4000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(B);
    expect(spotify.playsOf(B)).toHaveLength(1);
    driver.stop();
  });

  it("reissues a seek the client dropped during a send that raced attach()", async () => {
    const { spotify, room, driver, invoke } = setup();
    // This client drops any seek issued while the player is still playing.
    spotify.dropSeekWhilePlaying = true;
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    expect(spotify.trackUri).toBe(A);
    expect(spotify.positionMs).toBeLessThan(5000);

    // The room seeks to 2:00. The driver sends the seek — and the send is
    // held in flight while the user presses Sync. attach() forgets: the
    // outstanding list is cleared and the generation bumped.
    room.update({ pointer: pointerOn(A, Date.now() - 120_000) });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const inner = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "spotify_seek") {
        // The race decides at send time whether the client takes the seek.
        if (spotify.dropSeekWhilePlaying && !spotify.isPaused) {
          spotify.calls.push({ cmd, args });
        } else {
          inner(cmd, args);
        }
        await gate;
        return undefined;
      }
      return inner(cmd, args);
    });
    await run(TICK_MS * 3);
    driver.attach();
    // The race that made the client drop seeks is over now: a retry lands.
    spotify.dropSeekWhilePlaying = false;
    open();
    invoke.mockImplementation(inner);

    // The send awaited across the forget: hanging the dropped seek's
    // expectation on the fresh run would suppress reconcile for its whole
    // lifetime and the seek would never be tried again.
    await run(2000);
    expect(spotify.positionMs).toBeGreaterThanOrEqual(120_000);
    // Two seeks: the one that raced the attach, and the fresh run's retry.
    // Hanging the raced seek's expectation on the fresh run leaves only one.
    expect(spotify.calls.filter((c) => c.cmd === "spotify_seek").length).toBeGreaterThanOrEqual(2);
    driver.stop();
  });

  it("detaches within one tick when the user picks their own track", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    room.queue = [entry(B)];
    driver.start();
    await run(2000);
    expect(spotify.trackUri).toBe(A);

    spotify.userPlays(C);
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("detached");
    const after = spotify.calls.length;
    await run(2000);
    expect(spotify.calls.length).toBe(after);
    expect(spotify.trackUri).toBe(C);
    driver.stop();
  });

  it("detaches when the user pauses", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    expect(spotify.isPaused).toBe(false);

    spotify.isPaused = true;
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("detached");
    driver.stop();
  });

  it("detaches when the user seeks", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);

    spotify.positionMs = 120_000;
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("detached");
    driver.stop();
  });

  it("tells its listeners when the mode moves", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    const seen: string[] = [];
    driver.onModeChange((m) => seen.push(m));
    driver.start();
    await run(2000);
    spotify.userPlays(C);
    await run(TICK_MS * 2);

    expect(seen).toEqual(["attached", "detached"]);
    driver.stop();
  });

  it("corrects the player after the bridge comes back, without detaching", async () => {
    const { spotify, bridge, room, driver } = setup("lost");
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    // Nothing is issued while the bridge is down.
    expect(spotify.calls).toHaveLength(0);

    // Spotify moved on while we could not see it. That is not a detach: we had
    // no reading to compare against.
    spotify.userPlays(C);
    bridge.set("ready");
    await run(3000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(A);
    driver.stop();
  });

  it("stops re-issuing a track Spotify will not play", async () => {
    const { spotify, room, driver } = setup();
    spotify.unplayable = A;
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(60_000);

    expect(spotify.playsOf(A)).toHaveLength(5);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("issues nothing at all once the unplayable track is given up on", async () => {
    const { spotify, room, driver } = setup();
    spotify.unplayable = A;
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(60_000);
    expect(spotify.playsOf(A)).toHaveLength(5);

    // The seek and the pause that travel with a play must go quiet with it.
    // Left behind, they would seek whatever the user is listening to instead,
    // every tick, forever.
    const after = spotify.calls.length;
    await run(3000);
    expect(spotify.calls.length).toBe(after);
    driver.stop();
  });

  it("reports the stuck target to its listeners", async () => {
    const { spotify, room, driver } = setup();
    spotify.unplayable = A;
    room.pointer = pointerOn(A, Date.now());
    const seen: string[][] = [];
    driver.onStuckChange((t) => seen.push(t));
    driver.start();
    await run(60_000);

    expect(seen.at(-1)).toEqual([`play:${A}`]);
    driver.stop();
  });

  it("never replays the old track when Spotify crosses the boundary first", async () => {
    // A short track, so the driver watches every second of it rather than the
    // test jumping the clock past the window the rollover is registered in.
    const SHORT = 6000;
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt, { durationMs: SHORT });
    room.queue = [entry(B, B, SHORT)];
    spotify.trackDurationMs = SHORT;
    driver.start();
    await run(2000);
    expect(spotify.queueHead).toBe(B);

    // Spotify's gapless step fires a tick before our own clock gets there.
    await run(SHORT - 2000 - TICK_MS);
    spotify.runOutIntoQueue();
    expect(spotify.trackUri).toBe(B);

    // The gap before the server's new snapshot is where the old driver would
    // have issued play(A)+seek(end): A restarts and B plays twice.
    await run(200);
    room.update({ pointer: pointerOn(B, startedAt + SHORT), queue: [] });
    await run(3000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(B);
    expect(spotify.playsOf(A)).toHaveLength(1);
    expect(spotify.playsOf(B)).toHaveLength(0);
    driver.stop();
  });

  it("issues nothing at the player during an advert", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(6000);
    expect(spotify.trackUri).toBe(A);

    // Spotify drops an ad break in. It ends by itself; fighting it would seek
    // and re-play for its whole length.
    spotify.trackUri = AD;
    spotify.positionMs = 0;
    spotify.durationMs = 30_000;
    await run(TICK_MS * 2);
    const after = spotify.calls.length;
    await run(20_000);

    expect(spotify.calls.length).toBe(after);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("does not detach when a reading arrives late across a track boundary", async () => {
    const SHORT = 6000;
    const { spotify, room, driver, invoke } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt, { durationMs: SHORT });
    room.queue = [entry(B, B, SHORT)];
    spotify.trackDurationMs = SHORT;
    driver.start();

    // Read up to 2s from the end, so the rollover is registered, then let
    // observe fail straight across the transition.
    // Read past the point where the rollover is registered — the play takes
    // 800ms to land, so the track starts that much after the driver does.
    await run(SHORT - 1000);
    invoke.mockRejectedValue(new Error("busy"));

    // The track ends and Spotify steps into B while we cannot see it.
    await run(1000);
    spotify.runOutIntoQueue();
    await run(300);

    // The first reading back shows B. The rollover is what explains it: it was
    // registered before the stall and has not run out of time.
    invoke.mockRestore();
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("stays attached and stops the player when the queue runs dry", async () => {
    // Nothing queued behind this one. Spotify may autoplay something of its
    // own choosing at the end; that is its doing, not the user's, and the room
    // wants silence — so we end attached, paused, with an empty slot.
    const SHORT = 6000;
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now(), { durationMs: SHORT });
    room.queue = [];
    spotify.trackDurationMs = SHORT;
    driver.start();
    await run(SHORT - 1000);

    // The track ends and Spotify picks something for itself.
    spotify.userPlays("spotify:track:autoplay");
    await run(4000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.isPaused).toBe(true);
    expect(spotify.queueHead).toBeNull();
    driver.stop();
  });

  it("detaches when the stall outlives the rollover — the accepted limit", async () => {
    // A rollover's deadline is the track's own end plus 1.5s. A reading that
    // arrives later than that has nothing left to explain it, and the driver
    // hands the player back rather than assume. Documented, not desired: the
    // cost of guessing wrong the other way is fighting a user for the player.
    const SHORT = 6000;
    const { spotify, room, driver, invoke } = setup();
    room.pointer = pointerOn(A, Date.now(), { durationMs: SHORT });
    room.queue = [entry(B, B, SHORT)];
    spotify.trackDurationMs = SHORT;
    driver.start();

    await run(SHORT - 2000);
    invoke.mockRejectedValue(new Error("busy"));
    await run(5000);
    spotify.runOutIntoQueue();
    invoke.mockRestore();
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("detached");
    driver.stop();
  });

  it("does not detach when a long buffer finally starts playing", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now() - 60_000);
    // The client is already on the track, reporting 0 while it loads. Freezing
    // the model keeps it there: a real buffer holds at 0 for as long as it
    // takes, which is longer than the seek meant to place it lives for.
    spotify.trackUri = A;
    spotify.durationMs = TRACK_MS;
    spotify.isPaused = false;
    spotify.positionMs = 0;
    spotify.frozen = true;

    driver.start();
    await run(5000);
    expect(driver.mode()).toBe("attached");

    // It finishes loading and jumps to where it was asked to be.
    spotify.frozen = false;
    spotify.positionMs = 60_000;
    await run(TICK_MS * 2);

    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("discards a reading taken before attach() was called mid-tick", async () => {
    const spotify = new FakeSpotify();
    const bridge = new FakeBridge();
    const now = () => Date.now();
    const room = new FakeRoom(now);
    room.pointer = pointerOn(A, now());

    // A gate the test opens by hand, so one observe can be held mid-flight
    // while the user acts and attach() lands.
    let gate: { promise: Promise<void>; open: () => void } | null = null;
    const invoke = vi.fn(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === "spotify_observe") {
        // The reading is taken now; delivering it is what waits.
        const answer = spotify.observe(now()) as T;
        if (gate !== null) await gate.promise;
        return answer;
      }
      spotify.invoke(cmd, args, now());
      return undefined as T;
    });
    const timer: Timer = {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    const driver = new PlaybackDriver(room, invoke as never, bridge, timer, now);

    driver.start();
    await run(6000);
    expect(spotify.trackUri).toBe(A);

    // Shut the gate, so the next tick's reading is taken but not delivered.
    let open!: () => void;
    gate = { promise: new Promise<void>((resolve) => (open = resolve)), open: () => open() };
    await vi.advanceTimersByTimeAsync(TICK_MS);

    // With that reading in flight the user grabs the player and the user
    // presses Sync, which attaches. The in-flight reading describes the player
    // as it was before either — keeping it as the baseline detaches us at once.
    spotify.userPlays(C);
    driver.attach();
    gate.open();
    gate = null;
    await vi.advanceTimersByTimeAsync(0);
    await run(6000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(A);
    driver.stop();
  });

  it("plays the room's track again after attach()", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    spotify.userPlays(C);
    await run(TICK_MS * 2);
    expect(driver.mode()).toBe("detached");

    driver.attach();
    await run(3000);

    expect(driver.mode()).toBe("attached");
    expect(spotify.trackUri).toBe(A);
    driver.stop();
  });

  it("detaches on the user's say-so and issues nothing more", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);

    driver.detach();
    const after = spotify.calls.length;
    spotify.userPlays(C);
    await run(3000);

    expect(driver.mode()).toBe("detached");
    expect(spotify.calls.length).toBe(after);
    driver.stop();
  });

  it("pauses and clears the slot when the room plays nothing", async () => {
    const { spotify, room, driver } = setup();
    spotify.userPlays(C);
    spotify.queueHead = B;
    room.pointer = NULL_POINTER;
    driver.start();
    await run(2000);

    expect(spotify.isPaused).toBe(true);
    expect(spotify.queueHead).toBeNull();
    driver.stop();
  });

  it("restarts without blaming the user for a move made while stopped", async () => {
    const { spotify, room, driver } = setup();
    const startedAt = Date.now();
    room.pointer = pointerOn(A, startedAt);
    room.queue = [entry(B)];
    driver.start();
    await run(2000);
    expect(spotify.trackUri).toBe(A);

    // Leaving the room stops the driver. While nobody is watching, Spotify
    // steps into the queued track by itself.
    driver.stop();
    spotify.runOutIntoQueue();
    room.update({ pointer: pointerOn(B, startedAt + TRACK_MS), queue: [] });
    await run(300);

    // Rejoining restarts it. The run that stopped never commanded this move —
    // but comparing the old reading against the fresh one would see exactly
    // that, blame the user, and detach at once.
    driver.start();
    await run(TICK_MS * 2);
    expect(driver.mode()).toBe("attached");
    driver.stop();
  });

  it("issues nothing after stop()", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    driver.stop();

    const after = spotify.calls.length;
    await run(3000);
    expect(spotify.calls.length).toBe(after);
  });

  it("keeps reconciling when a tick throws", async () => {
    const { spotify, room, driver } = setup();
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);
    expect(spotify.trackUri).toBe(A);

    // A room snapshot the driver cannot digest. The tick fails — that must
    // surface as one reported error, not as an unhandled rejection leaking
    // from every `void this.tick()` call site, and the loop must go on.
    const spy = vi.spyOn(room, "getPlaybackPointer").mockImplementation(() => {
      throw new Error("malformed pointer");
    });
    await run(TICK_MS * 2);
    expect(driver.mode()).toBe("attached");

    // A good snapshot lands: the loop is still reconciling.
    spy.mockRestore();
    await run(2000);
    expect(spotify.trackUri).toBe(A);
    driver.stop();
  });

  it("survives a bridge that refuses every command", async () => {
    const { room, driver, invoke } = setup();
    invoke.mockRejectedValue(new Error("bridge is down"));
    room.pointer = pointerOn(A, Date.now());
    driver.start();
    await run(2000);

    expect(driver.mode()).toBe("attached");
    driver.stop();
  });
});
