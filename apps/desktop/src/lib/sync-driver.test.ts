import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncDriver } from "./sync-driver";
import type { ControlState, PlayerState } from "./sync-driver";
import type { PlaybackPointer, Room, SessionEntry } from "./room";
import type { BridgeState, BridgeStateSource } from "./bridge-state";

const URI = "spotify:track:x";
const EPOCH = 1_700_000_000_000;
const OWNER = "aa".repeat(32);

function playingPointer(overrides: Partial<PlaybackPointer> = {}): PlaybackPointer {
  return {
    itemId: "i1",
    ownerPubkey: OWNER,
    uri: URI,
    startedAtEpochMs: EPOCH,
    isPaused: false,
    pausedAtOffsetMs: 0,
    ...overrides,
  };
}

const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerPubkey: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

const NEXT_URI = "spotify:track:y";

function entry(id: string, uri: string): SessionEntry {
  return {
    item: { id, uri, trackId: id },
    ownerPubkey: OWNER,
    ownerName: "alice",
  };
}

/**
 * The slice of RoomClient that SyncDriver touches, plus test controls.
 *
 * It serves a snapshot rather than computing one: the server decides the
 * session queue and the pointer, so the fake just hands them over.
 */
function makeRoom(pointer: PlaybackPointer, myPubkey: string = OWNER) {
  const listeners = new Set<() => void>();
  let queue: SessionEntry[] = [entry("i2", NEXT_URI)];
  const fake = {
    myPubkey,
    sessionQueue: (): SessionEntry[] => queue,
    getPlaybackPointer: () => pointer,
    setMyProgress: vi.fn(),
    skip: vi.fn(),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Replaces the pointer and notifies the driver, as a new snapshot would. */
    setPointer(next: PlaybackPointer) {
      pointer = next;
      for (const listener of listeners) listener();
    },
    /** Replaces the session queue and notifies the driver, as a new snapshot would. */
    setQueue(next: SessionEntry[]) {
      queue = next;
      for (const listener of listeners) listener();
    },
    /**
     * Replaces the session queue without notifying, for the instant a snapshot
     * has landed on the room but the driver's own tick is still in flight.
     */
    setQueueQuietly(next: SessionEntry[]) {
      queue = next;
    },
  };
  return fake;
}

type FakeRoom = ReturnType<typeof makeRoom>;

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

/**
 * Records every command, answers `spotify_get_state` from a mutable script,
 * and keeps a one-slot Spotify queue the driver's own commands edit — the
 * driver reads it back, so the fake has to behave like the real one.
 */
function makeInvoke(
  state: () => PlayerState | null,
  queueHead: string | null = null,
  /** Runs inside the `spotify_get_state` read, as a snapshot landing mid-tick does. */
  during?: () => void,
) {
  const calls: Call[] = [];
  let head = queueHead;
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === "spotify_get_state") {
      during?.();
      return state() as T;
    }
    if (cmd === "spotify_get_queue") return (head === null ? [] : [head]) as T;
    if (cmd === "spotify_set_next_track") head = args?.uri as string;
    if (cmd === "spotify_clear_queue") head = null;
    return undefined as T;
  };
  return {
    calls,
    invoke,
    names: () => calls.map((call) => call.cmd),
    of: (cmd: string) => calls.filter((call) => call.cmd === cmd),
    /** Commands the driver sent to the player, with the reads dropped. */
    commands: () =>
      calls
        .map((call) => call.cmd)
        .filter((cmd) => cmd !== "spotify_get_state" && cmd !== "spotify_get_queue"),
    queueHead: () => head,
  };
}

/** An invoke that rejects everything, as the bridge does while it is down. */
function makeFailingInvoke() {
  const calls: Call[] = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    throw new Error("spotify bridge: lost");
  };
  return { calls, invoke, names: () => calls.map((call) => call.cmd) };
}

/**
 * A bridge whose state the test drives by hand. Like the real source, it calls
 * a new subscriber back with the current state at once.
 */
function makeBridge(initial: BridgeState = "ready") {
  const listeners = new Set<(state: BridgeState) => void>();
  let current = initial;
  return {
    source: {
      subscribe(listener: (state: BridgeState) => void) {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
      },
      connect: async (): Promise<BridgeState> => "ready",
    } satisfies BridgeStateSource,
    listenerCount: () => listeners.size,
    emit(state: BridgeState) {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

/** A bridge that says nothing, so a driver under test is never gated on it. */
const SILENT_BRIDGE: BridgeStateSource = {
  subscribe: () => () => {},
  connect: async () => "ready",
};

function startDriver(
  room: FakeRoom,
  invoke: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> },
  bridge: BridgeStateSource = SILENT_BRIDGE,
) {
  const driver = new SyncDriver(room as unknown as Room, invoke.invoke, bridge);
  driver.start();
  return driver;
}

/** Runs `count` poll intervals, letting each tick's promise chain settle. */
async function pollTimes(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(2000);
  }
}

/** Lets the tick started by `start()` or a room change finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("SyncDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("spotify queue mirroring", () => {
    it("queues the session head on start", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.of("spotify_set_next_track")).toHaveLength(1);
      expect(invoke.of("spotify_set_next_track")[0].args).toEqual({ uri: NEXT_URI });
      driver.stop();
    });

    it("re-queues when the head changes", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setQueue([entry("i9", "spotify:track:z")]);
      await settle();

      const sets = invoke.of("spotify_set_next_track");
      expect(sets).toHaveLength(1);
      expect(sets[0].args).toEqual({ uri: "spotify:track:z" });
      driver.stop();
    });

    it("does not re-queue while Spotify already holds the head", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setQueue([entry("i2", NEXT_URI)]); // same head uri
      await settle();
      room.setPointer(playingPointer()); // unrelated change
      await settle();

      expect(invoke.names()).not.toContain("spotify_set_next_track");
      driver.stop();
    });

    it("clears Spotify's queue when the head goes away", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setQueue([]);
      await settle();

      expect(invoke.of("spotify_clear_queue")).toHaveLength(1);
      driver.stop();
    });

    it("leaves Spotify's queue alone when the pointer goes null", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      room.setQueue([]);
      await settle();
      invoke.calls.length = 0;

      room.setPointer(NULL_POINTER);
      await settle();

      // An empty room is not ours to drive: no pause, no queue edit.
      expect(invoke.names()).not.toContain("spotify_pause");
      expect(invoke.of("spotify_clear_queue")).toHaveLength(0);
      driver.stop();
    });

    it("re-sets the queue after Spotify consumed it on a transition", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      expect(invoke.queueHead()).toBe(NEXT_URI);
      invoke.calls.length = 0;

      // Spotify played the queued track, so its slot is empty again.
      await invoke.invoke("spotify_clear_queue");
      invoke.calls.length = 0;
      await pollTimes(1);

      const sets = invoke.of("spotify_set_next_track");
      expect(sets).toHaveLength(1);
      expect(sets[0].args).toEqual({ uri: NEXT_URI });
      driver.stop();
    });
  });

  describe("adopting a track Spotify already plays", () => {
    const onTarget: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 1200,
      durationMs: 200_000,
    };

    it("does not replay the track", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 1000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("does not seek while within 3s of the shared clock", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 1000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });

    it("seeks when off the shared clock by more than 3s", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 20_000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await settle();

      const seeks = invoke.of("spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 20_000 });
      driver.stop();
    });

    it("still applies the pointer's pause state", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 1000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).toContain("spotify_pause");
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("plays as usual when the state read fails", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).toContain("spotify_play_track");
      driver.stop();
    });
  });

  describe("natural Spotify transition", () => {
    function onOurTrack(): PlayerState {
      return {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 2000,
        durationMs: 30_000,
      };
    }

    it("does not fight Spotify when it moves into the queued track", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // observedOnTrack = true
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      invoke.calls.length = 0;
      await pollTimes(1);

      // The server moves the pointer; the driver must not seek or replay.
      expect(invoke.names()).not.toContain("spotify_seek");
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("follows the server's new pointer once the snapshot lands", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      await pollTimes(1);

      // The server consumed the head and pushed a pointer at the next track.
      room.setQueue([]);
      room.setPointer(
        playingPointer({ itemId: "i2", uri: NEXT_URI, startedAtEpochMs: EPOCH + 3200 }),
      );
      await settle();

      // Spotify is already there, so it is adopted rather than replayed.
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });
  });

  describe("empty pointer", () => {
    it("leaves Spotify playing when the pointer goes null after a played item", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();
      expect(invoke.names()).toContain("spotify_play_track");
      invoke.calls.length = 0;

      room.setPointer(NULL_POINTER);
      await settle();

      expect(invoke.names()).not.toContain("spotify_pause");
      driver.stop();
    });

    it("touches nothing on the first tick, so joining a quiet room keeps the user's music", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).not.toContain("spotify_pause");
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("never pauses while the room stays empty", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      room.setQueue([]);
      await settle();

      expect(invoke.of("spotify_pause")).toHaveLength(0);
      driver.stop();
    });
  });

  describe("late join into a paused room", () => {
    it("plays, seeks to the frozen offset, then pauses — in that order", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 45_000 }));
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.commands()).toEqual([
        "spotify_play_track",
        "spotify_seek",
        "spotify_pause",
        "spotify_set_next_track",
      ]);
      expect(invoke.of("spotify_seek")[0].args).toEqual({ positionMs: 45_000 });
      driver.stop();
    });

    it("does not seek when the room is paused near the top of the track", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 500 }));
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });

    it("resumes and re-aligns to the shared clock", async () => {
      // The player sits well behind the shared clock: the room played on past
      // where this player stopped, so the resume has something to re-align.
      const paused: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: true,
        positionMs: 12_000,
        durationMs: 200_000,
      };
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 12_000 }));
      const invoke = makeInvoke(() => paused);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setPointer(playingPointer({ startedAtEpochMs: EPOCH - 45_000 }));
      await settle();

      const names = invoke.names();
      const resumeIndex = names.indexOf("spotify_resume");
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(invoke.calls[resumeIndex + 1]).toEqual({
        cmd: "spotify_seek",
        args: { positionMs: 45_000 },
      });
      driver.stop();
    });
  });

  describe("drift correction", () => {
    it("never seeks while Spotify still reports position 0", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 20_000 }));
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 0,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      await pollTimes(5);

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });

    it("seeks once the player is on the track and behind the shared clock", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 20_000 }));
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 5000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      // The first tick already seeked; the grace window has to pass first.
      await pollTimes(4);

      const seeks = invoke.of("spotify_seek");
      expect(seeks.length).toBeGreaterThan(0);
      expect(seeks[0].args).toEqual({ positionMs: 26_000 });
      driver.stop();
    });

    it("does not repeat a seek inside the grace window", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 20_000 }));
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 5000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);
      await settle();
      expect(invoke.of("spotify_seek")).toHaveLength(1);
      invoke.calls.length = 0;

      await pollTimes(2); // 4s: still inside the 5s window

      expect(invoke.of("spotify_seek")).toHaveLength(0);
      driver.stop();
    });

    it("stops correcting drift once the clock runs past the track's duration", async () => {
      // Started 12s ago against a 10s track: already past duration + 3s.
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 12_000 }));
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 10_000,
        durationMs: 10_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      await pollTimes(1);

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });
  });

  describe("re-issuing what never landed", () => {
    it("does not repeat a play for the same track inside the grace window", async () => {
      const room = makeRoom(playingPointer());
      // Spotify never moves: every play is lost.
      const invoke = makeInvoke(() => ({
        trackUri: "spotify:track:other",
        trackName: "other",
        isPaused: false,
        positionMs: 1000,
        durationMs: 200_000,
      }));
      const driver = startDriver(room, invoke);
      await settle();
      expect(invoke.of("spotify_play_track")).toHaveLength(1);

      await pollTimes(2); // 4s: still inside the 5s grace window

      expect(invoke.of("spotify_play_track")).toHaveLength(1);
      driver.stop();
    });

    it("re-plays a still-wrong track once the grace window has passed", async () => {
      const room = makeRoom(playingPointer());
      // Spotify reports our track for control purposes but never actually
      // moves, so `following` holds and the play is simply lost.
      const invoke = makeInvoke(() => ({
        trackUri: null,
        trackName: null,
        isPaused: false,
        positionMs: 0,
        durationMs: 0,
      }));
      const driver = startDriver(room, invoke);
      await settle();
      expect(invoke.of("spotify_play_track")).toHaveLength(1);

      await pollTimes(3); // 6s: past the grace window

      expect(invoke.of("spotify_play_track").length).toBeGreaterThan(1);
      expect(invoke.of("spotify_play_track")[1].args).toEqual({ uri: URI });
      driver.stop();
    });
  });

  describe("progress reporting", () => {
    it("pumps progress while the player is on the pointer's track", async () => {
      const room = makeRoom(playingPointer());
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 5000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);

      expect(room.setMyProgress).toHaveBeenCalledWith({
        itemId: "i1",
        positionMs: 5000,
        durationMs: 200_000,
        sampledAtEpochMs: EPOCH + 2000,
      });
      driver.stop();
    });

    it("does not pump progress while Spotify is on some other track", async () => {
      const room = makeRoom(playingPointer());
      const state: PlayerState = {
        trackUri: "spotify:track:other",
        trackName: "other",
        isPaused: false,
        positionMs: 5000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(2);

      expect(room.setMyProgress).not.toHaveBeenCalled();
      driver.stop();
    });

    it("does not pump progress while the room is paused", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 45_000 }));
      const paused: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: true,
        positionMs: 45_000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => paused);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      await pollTimes(3);

      // Each tick still reads the player and its queue, but nothing is
      // reported and no command is sent.
      expect(room.setMyProgress).not.toHaveBeenCalled();
      expect(invoke.commands()).toEqual([]);
      driver.stop();
    });

    it("clears progress when the pointer goes null", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      room.setPointer(NULL_POINTER);
      await settle();

      expect(room.setMyProgress).toHaveBeenCalledWith(null);
      driver.stop();
    });

    it("reports a positive position for the pointer's item, as the room UI reads it", async () => {
      // The user-level symptom of a driver that never reports: the room hero
      // renders the playing track as "-:--" because no progress ever arrives.
      const room = makeRoom(playingPointer());
      const state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 12_000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);

      const reports = (room.setMyProgress as ReturnType<typeof vi.fn>).mock.calls
        .map(([progress]) => progress)
        .filter((progress) => progress !== null);
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0].itemId).toBe("i1");
      expect(reports[0].positionMs).toBeGreaterThan(0);
      driver.stop();
    });

    it("reports where the player really is when the user scrubs, and pulls it back", async () => {
      // Reporting reality is the contract: peers see this client's own
      // position, not the room's idea of it. What keeps that from corrupting
      // the room is that the same tick seeks the player back onto the clock.
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 30_000 }));
      let state: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 30_000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;
      room.setMyProgress.mockClear();

      // The user drags the local player far from where the room sits.
      state = { ...state, positionMs: 150_000 };
      await pollTimes(3); // past the seek grace window

      expect(room.setMyProgress).toHaveBeenCalledWith(
        expect.objectContaining({ positionMs: 150_000 }),
      );
      const seeks = invoke.of("spotify_seek");
      expect(seeks.length).toBeGreaterThan(0);
      driver.stop();
    });

    it("clears progress when the track's own end arrives", async () => {
      const room = makeRoom(playingPointer());
      const track: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 2000,
        durationMs: 30_000,
      };
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // schedules the end for EPOCH + 31_500
      (room.setMyProgress as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(29_500);

      expect(room.setMyProgress).toHaveBeenCalledWith(null);
      driver.stop();
    });

    it("keeps progress cleared once the end arrived, however long the pointer sits", async () => {
      // Clearing it on the timer is worth nothing if the next poll puts it
      // straight back. Spotify may well still report the finished track —
      // parked at its end — and reporting that draws a live progress bar on a
      // track that is over, on every listener's screen, until the pointer moves.
      const room = makeRoom(playingPointer());
      const track: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 29_000,
        durationMs: 30_000,
      };
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(29_500); // the end timer fires
      (room.setMyProgress as ReturnType<typeof vi.fn>).mockClear();
      await pollTimes(5);

      const reported = (room.setMyProgress as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] !== null,
      );
      expect(reported).toEqual([]);
      driver.stop();
    });
  });

  describe("remote seek", () => {
    it("seeks the local player when the clock moves under an unchanged item", async () => {
      // The player tracks the shared clock exactly, so no drift seek fires and
      // the memo stays empty until the room itself moves.
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 30_000 }));
      const invoke = makeInvoke(() => ({
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: Date.now() - (EPOCH - 30_000),
        durationMs: 200_000,
      }));
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      // Somebody dragged the room to 90s.
      room.setPointer(playingPointer({ startedAtEpochMs: Date.now() - 90_000 }));
      await settle();

      const seeks = invoke.of("spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 90_000 });
      driver.stop();
    });

    it("seeks to the frozen offset when the room seeks while paused", async () => {
      const paused: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: true,
        positionMs: 10_000,
        durationMs: 200_000,
      };
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 10_000 }));
      const invoke = makeInvoke(() => paused);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setPointer(playingPointer({ isPaused: true, pausedAtOffsetMs: 90_000 }));
      await settle();

      const seeks = invoke.of("spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 90_000 });
      driver.stop();
    });

    it("does not seek when an unrelated change leaves the player on the clock", async () => {
      const onTrack: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 1000,
        durationMs: 200_000,
      };
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 1000 }));
      const invoke = makeInvoke(() => onTrack);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0;

      room.setPointer(playingPointer({ startedAtEpochMs: EPOCH - 1000 }));
      await settle();

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });
  });

  describe("the owner reports the end of its track", () => {
    const OTHER = "bb".repeat(32);

    /** Spotify sitting on our track, well short of the end. */
    function onOurTrack(): PlayerState {
      return {
        trackUri: URI,
        trackName: "x",
        isPaused: false,
        positionMs: 2000,
        durationMs: 30_000,
      };
    }

    it("skips when the end timer fires", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => onOurTrack());
      const driver = startDriver(room, invoke);

      await pollTimes(1); // schedules the end for EPOCH + 31_500
      await vi.advanceTimersByTimeAsync(29_500);

      expect(room.skip).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("skips when Spotify transitions into the queued track", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // observedOnTrack = true
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      await pollTimes(1);

      expect(room.skip).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("skips when the player parks at the very end of the track", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // observedOnTrack = true
      state = { ...state, isPaused: true, positionMs: 30_000 };
      await pollTimes(1);

      expect(room.skip).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("stays quiet when somebody else owns the item", async () => {
      const room = makeRoom(playingPointer(), OTHER);
      const invoke = makeInvoke(() => onOurTrack());
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(29_500);

      expect(room.skip).not.toHaveBeenCalled();
      driver.stop();
    });

    it("skips an item only once, however often its end is seen", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => onOurTrack());
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(29_500); // the end timer fires
      await pollTimes(3); // and the tick keeps seeing a finished track

      expect(room.skip).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("does not report an end that only arrived because the room was paused", async () => {
      // The fallback timer is aimed at the shared clock's end of track. A room
      // that pauses stops that clock, so the instant the timer holds is no
      // longer the end of anything: it must be dropped, not left to fire.
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // schedules the end for EPOCH + 31_500

      // The room pauses 4s in, well before the track would have run out.
      state = { ...state, isPaused: true, positionMs: 4000 };
      room.setPointer(playingPointer({ isPaused: true, pausedAtOffsetMs: 4000 }));
      await settle();

      // Sit paused past the instant the stale timer was aimed at.
      await vi.advanceTimersByTimeAsync(40_000);

      expect(room.skip).not.toHaveBeenCalled();
      driver.stop();
    });

    it("still reports the end after the room pauses and resumes", async () => {
      // Clearing the timer on pause must not lose the backstop: the resumed
      // clock schedules a fresh one against the new start instant.
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);

      state = { ...state, isPaused: true, positionMs: 4000 };
      room.setPointer(playingPointer({ isPaused: true, pausedAtOffsetMs: 4000 }));
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(room.skip).not.toHaveBeenCalled();

      // Resumed: the room restarts the clock 4s into a 30s track.
      state = { ...state, isPaused: false };
      room.setPointer(playingPointer({ startedAtEpochMs: Date.now() - 4000 }));
      await settle();
      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(room.skip).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("skips again once the pointer moves to a new item that ends", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => onOurTrack());
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(29_500);
      expect(room.skip).toHaveBeenCalledTimes(1);

      // The server consumed the skip and pushed the next item.
      room.setQueue([]);
      room.setPointer(playingPointer({ itemId: "i2", startedAtEpochMs: Date.now() }));
      await settle();

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(29_500);

      expect(room.skip).toHaveBeenCalledTimes(2);
      driver.stop();
    });
  });

  describe("the server owns advancing", () => {
    it("exposes no way for the driver to move the pointer", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await settle();

      // The old driver called room.advance(); the fake room no longer has one,
      // and nothing the driver does may reintroduce it.
      expect("advance" in room).toBe(false);
      driver.stop();
    });

    it("keeps ticking on a finished track without replaying it", async () => {
      // Spotify sits on our track, parked at the very end: it is over.
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 60_000 }));
      const finished: PlayerState = {
        trackUri: URI,
        trackName: "x",
        isPaused: true,
        positionMs: 10_000,
        durationMs: 10_000,
      };
      const invoke = makeInvoke(() => finished);
      const driver = startDriver(room, invoke);
      await settle();
      invoke.calls.length = 0; // drop the first tick

      await pollTimes(3);

      // The server moves the pointer; the driver never restarts the track.
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });
  });
});

describe("joining a room", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the local player alone when nothing is playing", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_pause")).toHaveLength(0);
  });

  it("leaves Spotify's queue alone while the room names no track", async () => {
    const room = makeRoom(NULL_POINTER);
    room.setQueue([]);
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_clear_queue")).toHaveLength(0);
    expect(invoke.of("spotify_set_next_track")).toHaveLength(0);
  });

  it("sets the next track once the room names one", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_set_next_track")[0]?.args).toEqual({ uri: NEXT_URI });
  });

  it("does not stop the player when the room is already playing", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_pause")).toHaveLength(0);
  });
});

describe("the user's own music against the room", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function ownMusic(): PlayerState {
    return {
      trackUri: "spotify:track:leftover",
      trackName: "leftover",
      isPaused: false,
      positionMs: 30_000,
      durationMs: 200_000,
    };
  }

  it("leaves a player that was left playing before the join alone", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_pause")).toHaveLength(0);
    driver.stop();
  });

  it("takes over a playing room even while the user plays their own track", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await settle();

    expect(invoke.of("spotify_play_track")).toHaveLength(1);
    driver.stop();
  });

  it("sync() takes the player back from a detached user", async () => {
    const room = makeRoom(playingPointer());
    // Spotify never lands on the room's track: the user keeps their own music on.
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await settle();
    expect(invoke.of("spotify_play_track")).toHaveLength(1);

    // The next ticks see the user's track and let go of the player.
    await pollTimes(2);
    expect(invoke.of("spotify_play_track")).toHaveLength(1);

    driver.sync();
    await settle();

    expect(invoke.of("spotify_play_track")).toHaveLength(2);
    expect(invoke.of("spotify_play_track")[1].args).toEqual({ uri: URI });
    driver.stop();
  });

  it("mashing sync() plays the track once, not once per press", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(2); // detached
    invoke.calls.length = 0;

    for (let i = 0; i < 5; i += 1) driver.sync();
    await settle();

    expect(invoke.of("spotify_play_track")).toHaveLength(1);
    driver.stop();
  });

  it("leaves no listener or timer behind however often sync() is pressed", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const bridge = makeBridge();
    const driver = startDriver(room, invoke, bridge.source);
    await settle();

    for (let i = 0; i < 5; i += 1) {
      driver.sync();
      await settle();
    }

    expect(bridge.listenerCount()).toBe(1);
    driver.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never skips the room when the user switches to an unrelated track", async () => {
    const room = makeRoom(playingPointer());
    const onTrack: PlayerState = {
      trackUri: URI,
      trackName: "room track",
      isPaused: false,
      positionMs: 10_000,
      durationMs: 200_000,
    };
    let state: PlayerState = onTrack;
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(1);

    state = ownMusic();
    await pollTimes(2);

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });
});

describe("the bridge to Spotify going down and coming back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends no command and logs nothing while the bridge is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = makeRoom(playingPointer());
    const invoke = makeFailingInvoke();
    const bridge = makeBridge("lost");
    const driver = startDriver(room, invoke, bridge.source);
    await settle();

    await pollTimes(3);

    expect(invoke.calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    driver.stop();
  });

  it("plays on the next tick once the bridge comes back, with no Sync", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    const bridge = makeBridge("lost");
    const driver = startDriver(room, invoke, bridge.source);
    await settle();
    expect(invoke.calls).toHaveLength(0);

    bridge.emit("ready");
    await pollTimes(1);

    const plays = invoke.of("spotify_play_track");
    expect(plays).toHaveLength(1);
    expect(plays[0].args).toEqual({ uri: URI });
    driver.stop();
  });

  it("leaves a detached user alone when the bridge comes back", async () => {
    const room = makeRoom(playingPointer());
    // Spotify never lands on the room's track: the user keeps their own music on.
    const invoke = makeInvoke(() => ({
      trackUri: "spotify:track:leftover",
      trackName: "leftover",
      isPaused: false,
      positionMs: 30_000,
      durationMs: 200_000,
    }));
    const bridge = makeBridge();
    const driver = startDriver(room, invoke, bridge.source);
    await settle();
    expect(invoke.of("spotify_play_track")).toHaveLength(1);

    // The next ticks see the user's track and let go of the player.
    await pollTimes(2);
    invoke.calls.length = 0;

    bridge.emit("lost");
    bridge.emit("ready");
    await pollTimes(1);

    expect(invoke.of("spotify_play_track")).toHaveLength(0);
    driver.stop();
  });

  // The real source reports asynchronously, so the first tick always runs
  // before any state has arrived, and a source that never reports at all must
  // not deadlock the driver. An unknown bridge is driven best-effort: the
  // commands either land or fail, and a failure is logged once.
  it("drives the player while the bridge has said nothing yet", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    const driver = startDriver(room, invoke, SILENT_BRIDGE);

    await settle();
    await pollTimes(2);

    expect(invoke.of("spotify_play_track").length).toBeGreaterThan(0);
    driver.stop();
  });

  it("stop() unsubscribes from the bridge", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    const bridge = makeBridge();
    const driver = startDriver(room, invoke, bridge.source);
    await settle();
    expect(bridge.listenerCount()).toBe(1);

    driver.stop();
    invoke.calls.length = 0;
    bridge.emit("lost");
    bridge.emit("ready");
    await settle();

    expect(bridge.listenerCount()).toBe(0);
    expect(invoke.names()).not.toContain("spotify_play_track");
  });
});

describe("reporting control to the UI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The user's own track, which Spotify never leaves: the driver has to let go. */
  function ownMusic(): PlayerState {
    return {
      trackUri: "spotify:track:leftover",
      trackName: "leftover",
      isPaused: false,
      positionMs: 30_000,
      durationMs: 200_000,
    };
  }

  it("calls a new subscriber back with the current state at once", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    const driver = startDriver(room, invoke);
    await settle();

    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    expect(seen).toEqual(["following"]);
    driver.stop();
  });

  it("reports idle to a subscriber that arrives before the first evaluation", () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    const driver = new SyncDriver(room as unknown as Room, invoke.invoke, SILENT_BRIDGE);

    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    expect(seen).toEqual(["idle"]);
  });

  it("reports the move from following to detached", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);

    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));
    await settle();
    // The next ticks see the user's own track and let go of the player.
    await pollTimes(2);

    expect(seen).toEqual(["idle", "following", "detached"]);
    driver.stop();
  });

  it("stops reporting once the subscriber unsubscribes", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);

    const seen: ControlState[] = [];
    const unsubscribe = driver.onControlChange((control) => seen.push(control));
    await settle();
    expect(seen).toEqual(["idle", "following"]);

    unsubscribe();
    await pollTimes(2);

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });
});

/**
 * The room advances — somebody pressed skip, or a track ran out — and the new
 * pointer names a track Spotify is not on yet. Spotify still reports the track
 * that just ended, which is neither the new pointer's track nor the track now
 * queued behind it. That is the room's own transition, not the user taking the
 * player back, and the driver has to carry on driving through it.
 */
describe("the room advancing to a track Spotify is not on", () => {
  const THIRD_URI = "spotify:track:third";
  const OTHER = "bb".repeat(32);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Spotify sitting on the pointer's track, well short of the end. */
  function onOurTrack(): PlayerState {
    return {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 10_000,
      durationMs: 200_000,
    };
  }

  /**
   * Drives the room from item i1/URI to a new item whose track Spotify has not
   * reached. The player is left reporting the old track, exactly as it does for
   * the beat after the server's snapshot lands.
   */
  async function advanceTo(
    room: FakeRoom,
    itemId: string,
    uri: string,
    ownerPubkey: string = OWNER,
  ): Promise<void> {
    room.setQueue([entry("i9", THIRD_URI)]);
    room.setPointer(
      playingPointer({ itemId, uri, ownerPubkey, startedAtEpochMs: Date.now() }),
    );
    await settle();
  }

  it("plays the new track when the room advances under a playing client", async () => {
    const room = makeRoom(playingPointer());
    const state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(1);
    invoke.calls.length = 0;

    await advanceTo(room, "i2", NEXT_URI);

    const plays = invoke.of("spotify_play_track");
    expect(plays).toHaveLength(1);
    expect(plays[0].args).toEqual({ uri: NEXT_URI });
    driver.stop();
  });

  it("keeps following across the seam instead of reading it as the user taking over", async () => {
    const room = makeRoom(playingPointer());
    const state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));
    await settle();
    await pollTimes(1);

    await advanceTo(room, "i2", NEXT_URI);

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });

  // The user's report: A presses skip on an item B owns. The server advances
  // for anyone, so A's next pointer names B's track — and A's Spotify is still
  // on the old one. A must play it and report progress once it lands there.
  it("a skip advances the room and this client follows onto the new track", async () => {
    const room = makeRoom(playingPointer(), OWNER);
    let state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(1);
    invoke.calls.length = 0;
    room.setMyProgress.mockClear();

    // The user presses skip. The server advances to an item somebody else owns.
    room.skip();
    await advanceTo(room, "i2", NEXT_URI, OTHER);

    const plays = invoke.of("spotify_play_track");
    expect(plays).toHaveLength(1);
    expect(plays[0].args).toEqual({ uri: NEXT_URI });

    // Spotify lands on it, and this client starts reporting where it sits.
    state = { ...state, trackUri: NEXT_URI, positionMs: 1500 };
    await pollTimes(1);

    expect(room.setMyProgress).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "i2", positionMs: 1500 }),
    );
    driver.stop();
  });

  it("does not read the seam as the end of the new item", async () => {
    const room = makeRoom(playingPointer());
    const state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(1); // observedOnTrack = true for i1
    room.skip.mockClear();

    // The new item's track is THIRD_URI, and the queue head behind it is the
    // track Spotify still reports. A stale `observedOnTrack` would read that as
    // "moved into the queued next" and fire a bogus skip at once.
    room.setQueue([entry("i9", URI)]);
    room.setPointer(
      playingPointer({ itemId: "i2", uri: THIRD_URI, startedAtEpochMs: Date.now() }),
    );
    await settle();

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("sends one skip for an item, not one per detector", async () => {
    const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 100_000 }));
    // Parked paused at the very end, and past the shared clock's duration:
    // three detectors see the same end on the same tick.
    const finished: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: true,
      positionMs: 30_000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => finished);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(3);

    expect(room.skip).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it("still detaches when the user leaves the room's track under a still pointer", async () => {
    const room = makeRoom(playingPointer());
    let state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();
    await pollTimes(1);

    // The room advances; the client follows through the seam.
    await advanceTo(room, "i2", NEXT_URI);
    state = { ...state, trackUri: NEXT_URI };
    await pollTimes(1);
    invoke.calls.length = 0;

    // Now the user puts their own music on while the pointer holds still.
    state = { ...state, trackUri: "spotify:track:mine" };
    await pollTimes(2);

    expect(invoke.names()).not.toContain("spotify_play_track");
    driver.stop();
  });
});

/**
 * A session-queue snapshot landing while a tick reads Spotify. The tick must
 * decide and act against one queue: reading the head twice, either side of the
 * read, lets it judge control against the old head and act on the new one.
 */
describe("a session queue that changes mid-tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function onOurTrack(): PlayerState {
    return {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
  }

  it("reports the end of the track Spotify moved into against the head it judged control by", async () => {
    // Spotify performs its own gapless move into NEXT_URI, the head this tick
    // read for its control decision. A snapshot lands in that same tick and
    // replaces the head. The move is still the end of our item and still a
    // skip; a second read of the queue makes the tick forget it.
    const room = makeRoom(playingPointer());
    let state = onOurTrack();
    let swap = false;
    const invoke = makeInvoke(
      () => state,
      null,
      () => {
        if (!swap) return;
        swap = false;
        room.setQueue([entry("i9", "spotify:track:third")]);
      },
    );
    const driver = startDriver(room, invoke);

    await pollTimes(1); // observedOnTrack = true, head is NEXT_URI
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    swap = true;
    await pollTimes(1);

    expect(room.skip).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it("keeps following through a gapless move the queue changed under", async () => {
    // The same race seen from the control seam: the tick must not read
    // Spotify's move into the head it judged control by as a user takeover.
    const room = makeRoom(playingPointer());
    let state = onOurTrack();
    let swap = false;
    const invoke = makeInvoke(
      () => state,
      null,
      () => {
        if (!swap) return;
        swap = false;
        room.setQueueQuietly([entry("i9", "spotify:track:third")]);
      },
    );
    const driver = startDriver(room, invoke);
    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    await pollTimes(1);
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    swap = true;
    await pollTimes(1);

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });
});

describe("stopping the driver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes nothing to the room from a tick still in flight when stop() lands", async () => {
    const room = makeRoom(playingPointer());
    const state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 5000,
      durationMs: 200_000,
    };
    let driver: SyncDriver | null = null;
    // stop() arrives while the tick is parked on its Spotify read, as a user
    // leaving the room does.
    const invoke = makeInvoke(
      () => state,
      null,
      () => driver?.stop(),
    );
    driver = new SyncDriver(room as unknown as Room, invoke.invoke, SILENT_BRIDGE);
    driver.start();

    await settle();

    expect(room.setMyProgress).not.toHaveBeenCalled();
  });

  it("sends no command from a tick still in flight when stop() lands", async () => {
    const room = makeRoom(playingPointer());
    let driver: SyncDriver | null = null;
    const invoke = makeInvoke(
      () => null,
      null,
      () => driver?.stop(),
    );
    driver = new SyncDriver(room as unknown as Room, invoke.invoke, SILENT_BRIDGE);
    driver.start();

    await settle();

    expect(invoke.commands()).toEqual([]);
  });

  it("runs one catch-up tick for a burst of changes, not one each", async () => {
    // Every change during a tick sets the same `dirty` flag, so a burst
    // collapses into a single follow-up pass rather than a queue of them.
    const room = makeRoom(playingPointer());
    let bursts = 0;
    const invoke = makeInvoke(
      () => null,
      null,
      () => {
        if (bursts > 0) return;
        bursts += 1;
        for (let i = 0; i < 20; i += 1) room.setPointer(playingPointer());
      },
    );
    const driver = new SyncDriver(room as unknown as Room, invoke.invoke, SILENT_BRIDGE);
    driver.start();
    await settle();

    // The starting tick, plus exactly one catch-up for the whole burst.
    expect(invoke.of("spotify_get_state")).toHaveLength(2);
    driver.stop();
  });

  it("leaves no timer behind that fires after stop()", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ({
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    }));
    const driver = startDriver(room, invoke);
    await pollTimes(1); // schedules the end timer

    driver.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(room.skip).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports no end after stop, however the player moves", async () => {
    // The poll is cleared and the change listener dropped, so no reading after
    // stop() reaches an end detector at all. A `skip` sent from a room the user
    // has left moves the pointer for everybody still in it.
    const room = makeRoom(playingPointer());
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1); // observedOnTrack

    driver.stop();
    // Spotify goes gapless into the queued track — the clearest end there is.
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await vi.advanceTimersByTimeAsync(120_000);

    expect(room.skip).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * A reading that says "the track is over" when it is not costs everyone: the
 * owner sends `skip` and the room advances under every listener.
 */
describe("ends that are not ends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not read a blank player against an empty queue as a transition", async () => {
    // Spotify drops to no track — it is loading, or the read came back thin —
    // while the room's queue happens to be empty. Neither is the end of
    // anything, and "no track" must not match "nothing queued".
    const room = makeRoom(playingPointer());
    room.setQueue([]);
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 200_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);

    await pollTimes(1); // observedOnTrack = true
    state = { ...state, trackUri: null, positionMs: 0, durationMs: 0 };
    await pollTimes(1);

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("still reports the end of the room's last track, with nothing queued", async () => {
    // Two of the four end readings match the player against the track queued
    // behind ours, and there is none. The clock-based fallback reads the room,
    // not the player, so it still fires — which is why the last track in a room
    // does not wedge it.
    const room = makeRoom(playingPointer());
    room.setQueue([]);
    const invoke = makeInvoke(() => ({
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    }));
    const driver = startDriver(room, invoke);

    await pollTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(room.skip).toHaveBeenCalledTimes(1);
    driver.stop();
  });

  it("re-learns the track for a new item that plays the same uri", async () => {
    // The same track queued twice. Spotify never leaves it, so nothing about
    // the reading changes — but "we have seen the player reach this item" has
    // to start over, or the queued next reads as an end the moment it lands.
    const room = makeRoom(playingPointer());
    const state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 200_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1); // observedOnTrack = true for i1
    room.skip.mockClear();

    // A second item naming the same track, with the old track now queued
    // behind it. A stale `observedOnTrack` reads that as a transition.
    room.setQueue([entry("i9", URI)]);
    room.setPointer(playingPointer({ itemId: "i2", startedAtEpochMs: Date.now() }));
    await settle();

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("does not read the user's own track as an end when they press Sync", async () => {
    // `sync()` restarts the control decision but not what we have learnt about
    // the player. A user who wandered onto the very track we had queued, and
    // then attaches on purpose, must not have that read as our track finishing.
    const room = makeRoom(playingPointer());
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 200_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1); // observedOnTrack = true

    state = { ...state, trackUri: NEXT_URI, positionMs: 1000 };
    await pollTimes(3); // detached on the user's own music
    room.skip.mockClear();

    driver.sync();
    await settle();

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("gives a new item its own doubt about an overrun reading", async () => {
    // The doubt that lets a stale duration through is per item. An item that
    // used its doubt up must not leave the next one with none, or the first
    // reading of the next track is taken at face value and false-skips it.
    const room = makeRoom(playingPointer());
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 40_000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); // i1's doubt expires and it ends
    expect(room.skip).toHaveBeenCalledTimes(1);

    room.setQueue([]);
    room.setPointer(
      playingPointer({ itemId: "i2", uri: NEXT_URI, startedAtEpochMs: Date.now() - 60_000 }),
    );
    // The first reading of i2 is the stale beat: its uri against the old length.
    state = {
      trackUri: NEXT_URI,
      trackName: "y",
      isPaused: false,
      positionMs: 60_000,
      durationMs: 10_000,
    };
    room.skip.mockClear();
    await settle();
    await pollTimes(1);

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("does not call a track over on a duration Spotify has not caught up on", async () => {
    // Spotify reports the new track's uri a beat before it reports the new
    // track's length, so `durationMs` still belongs to the short track that
    // just ended. Against a pointer already well into a long track, that
    // reading says "over" the instant it is seen.
    const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 60_000 }));
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 60_000,
      durationMs: 10_000, // stale: the previous track was 10s long
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await settle();

    // Spotify catches up on the next read with the real length.
    state = { ...state, durationMs: 300_000 };
    await pollTimes(1);

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });
});

/**
 * Doubting a reading is right for a beat and wrong forever. A player that
 * reports a position past its own length is either Spotify mid-catch-up or a
 * player that really has run past the track. Treating every such reading as the
 * first leaves both end detectors off — the fallback timer is never aimed and
 * the clock check never runs — so the item never finishes and the room sits on
 * a dead track for as long as the player does.
 */
describe("a player that reports past its own duration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Playing, on the room's track, reporting 10s past a 30s length. */
  function overrun(): PlayerState {
    return {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 40_000,
      durationMs: 30_000,
    };
  }

  it("still calls the track over once the reading has held", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => overrun());
    const driver = startDriver(room, invoke);

    await pollTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(room.skip).toHaveBeenCalled();
    driver.stop();
  });

  it("does not call it over on the first such reading", async () => {
    // The beat where Spotify has the new uri against the old length. The
    // pointer is young, so nothing else says the track is over either.
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => overrun());
    const driver = startDriver(room, invoke);

    await pollTimes(2); // 4s: inside the doubt, past the 1.5s play grace

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });

  it("lets the user take the player back from an item it wedged on", async () => {
    // The end was reported and the server never answered. The grace the report
    // buys covers a round trip, so a user who puts their own music on gets the
    // player — the room does not play over them for the rest of the session.
    const room = makeRoom(playingPointer());
    let state = overrun();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);

    await pollTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.skip).toHaveBeenCalled();

    state = {
      trackUri: "spotify:track:mine",
      trackName: "mine",
      isPaused: false,
      positionMs: 5000,
      durationMs: 100_000,
    };
    await pollTimes(10); // the grace runs out
    invoke.calls.length = 0;
    await pollTimes(30);

    expect(invoke.of("spotify_play_track")).toEqual([]);
    driver.stop();
  });
});

/**
 * Saying "this item is over" buys the player a grace: control keeps following
 * even though Spotify sits on a track the pointer does not name, because we put
 * it there. The grace has to end. It covers one server round trip, and a server
 * that never answers — it is down, or this was the room's last track — must not
 * leave the driver playing over a user who has taken their player back.
 */
describe("an end the server never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the grace expire even while a detector keeps seeing the same end", async () => {
    const room = makeRoom(playingPointer());
    // Spotify parks paused at the very end of the track: `looksFinished` sees
    // the same end on every tick for as long as the pointer sits there.
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1); // observedOnTrack

    state = { ...state, isPaused: true, positionMs: 30_000 };
    await pollTimes(1);
    expect(room.skip).toHaveBeenCalledTimes(1);

    // No snapshot ever comes, and the parked player keeps re-firing the same
    // detector. Once the grace is spent the user's own music is theirs again.
    await pollTimes(10);
    state = {
      trackUri: "spotify:track:mine",
      trackName: "mine",
      isPaused: false,
      positionMs: 5000,
      durationMs: 100_000,
    };
    invoke.calls.length = 0;
    await pollTimes(5);

    expect(invoke.of("spotify_play_track")).toEqual([]);
    driver.stop();
  });

  it("gives the player back to a user who took it while we waited", async () => {
    const room = makeRoom(playingPointer());
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    await pollTimes(1); // observedOnTrack

    // Spotify goes gapless into the queued track and we report the end.
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await pollTimes(1);
    expect(room.skip).toHaveBeenCalledTimes(1);

    // No snapshot ever comes. The user puts their own music on.
    state = {
      trackUri: "spotify:track:mine",
      trackName: "mine",
      isPaused: false,
      positionMs: 5000,
      durationMs: 100_000,
    };
    await pollTimes(10); // the grace runs out
    invoke.calls.length = 0;
    await pollTimes(30);

    expect(invoke.of("spotify_play_track")).toEqual([]);
    driver.stop();
  });

  it("still holds the player across the gap the grace is for", async () => {
    // The mirror of the test above: within a round trip the driver keeps
    // following, so the client that reported the end is not stranded.
    const room = makeRoom(playingPointer());
    let state: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    await pollTimes(1);
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await pollTimes(1);
    room.setQueue([entry("i9", "spotify:track:third")]);
    await settle();
    await pollTimes(2); // 4s: well inside the grace

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });
});

describe("restarting a stopped driver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives the player again", async () => {
    // `stop()` makes a tick in flight write nothing more. That flag has to be
    // lifted by `start()`, or a restarted driver is silently dead: it polls, it
    // reads, and every command it decides on is dropped on the way out.
    const room = makeRoom(playingPointer());
    // The player sat still while we were stopped, so by the time we come back
    // it is well behind the shared clock and a seek is owed.
    const invoke = makeInvoke(() => ({
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 200_000,
    }));
    const driver = startDriver(room, invoke);
    await settle();
    driver.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    invoke.calls.length = 0;
    (room.setMyProgress as ReturnType<typeof vi.fn>).mockClear();

    driver.start();
    await settle();

    expect(invoke.of("spotify_seek")).toHaveLength(1);
    expect(room.setMyProgress).toHaveBeenCalledWith(expect.objectContaining({ itemId: "i1" }));
    driver.stop();
  });
});

/**
 * Spotify's own gapless transition lands the player on the queued track, and
 * the server has not answered the `skip` yet. For that gap the pointer names
 * the track that ended and the queue head has already moved on, so the player
 * sits on a track that matches neither. It is still the room's own transition,
 * and letting go of the player there strands the client: it stops driving, and
 * `reclaimed` will not take a playing player back at the next item either.
 */
describe("the gap between the gapless transition and the server's snapshot", () => {
  const THIRD_URI = "spotify:track:third";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function onOurTrack(): PlayerState {
    return {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };
  }

  it("keeps driving while the server catches up with the transition", async () => {
    const room = makeRoom(playingPointer());
    let state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    await pollTimes(1); // observedOnTrack = true
    // Spotify moves into the queued track; the driver reports the end.
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await pollTimes(1);
    expect(room.skip).toHaveBeenCalledTimes(1);

    // The server consumed the head into the next item, but has not pushed the
    // new pointer yet: the queue moved on while the pointer stands still.
    room.setQueue([entry("i9", THIRD_URI)]);
    await settle();
    await pollTimes(1);

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });

  it("keeps driving a client that does not own the item it saw end", async () => {
    // Only the owner sends `skip`, but every client sees the same transition
    // and sits in the same gap. A non-owner that lets go there is stranded too.
    const room = makeRoom(playingPointer(), "bb".repeat(32));
    let state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);
    const seen: ControlState[] = [];
    driver.onControlChange((control) => seen.push(control));

    await pollTimes(1);
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await pollTimes(1);

    room.setQueue([entry("i9", THIRD_URI)]);
    await settle();
    await pollTimes(1);

    expect(seen).toEqual(["idle", "following"]);
    driver.stop();
  });

  it("follows onto the new pointer once the snapshot finally lands", async () => {
    const room = makeRoom(playingPointer());
    let state = onOurTrack();
    const invoke = makeInvoke(() => state);
    const driver = startDriver(room, invoke);

    await pollTimes(1);
    state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
    await pollTimes(1);
    room.setQueue([entry("i9", THIRD_URI)]);
    await settle();
    await pollTimes(1);
    room.setMyProgress.mockClear();

    // The snapshot arrives: the pointer names the track Spotify already plays.
    room.setPointer(
      playingPointer({ itemId: "i2", uri: NEXT_URI, startedAtEpochMs: Date.now() - 800 }),
    );
    await settle();
    await pollTimes(1);

    expect(room.setMyProgress).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "i2" }),
    );
    driver.stop();
  });
});
