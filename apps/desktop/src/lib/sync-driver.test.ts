import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncDriver } from "./sync-driver";
import type { PlayerState } from "./sync-driver";
import type { PlaybackPointer, Room, SessionEntry } from "./room";

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
  };
  return fake;
}

type FakeRoom = ReturnType<typeof makeRoom>;

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Records every command; answers spotify_get_state from a mutable script. */
function makeInvoke(state: () => PlayerState | null) {
  const calls: Call[] = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === "spotify_get_state") return state() as T;
    return undefined as T;
  };
  return {
    calls,
    invoke,
    names: () => calls.map((call) => call.cmd),
    of: (cmd: string) => calls.filter((call) => call.cmd === cmd),
  };
}

function startDriver(room: FakeRoom, invoke: ReturnType<typeof makeInvoke>) {
  const driver = new SyncDriver(room as unknown as Room, invoke.invoke);
  driver.start();
  return driver;
}

/** Runs `count` poll intervals, letting each poll's promise chain settle. */
async function pollTimes(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(2000);
  }
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
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.of("spotify_set_next_track")).toHaveLength(1);
      expect(invoke.of("spotify_set_next_track")[0].args).toEqual({ uri: NEXT_URI });
      driver.stop();
    });

    it("re-queues when the head changes", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setQueue([entry("i9", "spotify:track:z")]);
      await vi.advanceTimersByTimeAsync(0);

      const sets = invoke.of("spotify_set_next_track");
      expect(sets).toHaveLength(1);
      expect(sets[0].args).toEqual({ uri: "spotify:track:z" });
      driver.stop();
    });

    it("does not re-queue while the head is unchanged", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setQueue([entry("i2", NEXT_URI)]); // same head uri
      await vi.advanceTimersByTimeAsync(0);
      room.setPointer(playingPointer()); // unrelated change
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).not.toContain("spotify_set_next_track");
      driver.stop();
    });

    it("clears Spotify's queue when the head goes away", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setQueue([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.of("spotify_clear_queue")).toHaveLength(1);
      driver.stop();
    });

    it("leaves Spotify's queue alone when the pointer goes null", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      room.setQueue([]);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setPointer(NULL_POINTER);
      await vi.advanceTimersByTimeAsync(0);

      // An empty room is not ours to drive: no pause, no queue edit.
      expect(invoke.names()).not.toContain("spotify_pause");
      expect(invoke.of("spotify_clear_queue")).toHaveLength(0);
      driver.stop();
    });

    it("re-sets the queue after a new item, because Spotify consumed it", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      // The head does not change, but the pointer moved on to a new item.
      room.setPointer(playingPointer({ itemId: "i7", uri: "spotify:track:q" }));
      await vi.advanceTimersByTimeAsync(0);

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
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("does not seek while within 3s of the shared clock", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 1000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).not.toContain("spotify_seek");
      driver.stop();
    });

    it("seeks when off the shared clock by more than 3s", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 20_000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      const seeks = invoke.of("spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 20_000 });
      driver.stop();
    });

    it("still applies the pointer's pause state", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 1000 }));
      const invoke = makeInvoke(() => onTarget);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).toContain("spotify_pause");
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("plays as usual when the state read fails", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

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
      await vi.advanceTimersByTimeAsync(0);

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
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke.names()).toContain("spotify_play_track");
      invoke.calls.length = 0;

      room.setPointer(NULL_POINTER);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).not.toContain("spotify_pause");
      driver.stop();
    });

    it("touches nothing on the first apply, so joining a quiet room keeps the user's music", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).not.toContain("spotify_pause");
      expect(invoke.names()).not.toContain("spotify_play_track");
      driver.stop();
    });

    it("never pauses while the room stays empty", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      room.setQueue([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.of("spotify_pause")).toHaveLength(0);
      driver.stop();
    });
  });

  describe("late join into a paused room", () => {
    it("plays, seeks to the frozen offset, then pauses — in that order", async () => {
      const room = makeRoom(
        playingPointer({ isPaused: true, pausedAtOffsetMs: 45_000 }),
      );
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).toEqual([
        // the control-state read, then the apply's own read
        "spotify_get_state",
        "spotify_get_state",
        "spotify_play_track",
        "spotify_seek",
        "spotify_pause",
        "spotify_set_next_track",
      ]);
      expect(invoke.calls[3].args).toEqual({ positionMs: 45_000 });
      driver.stop();
    });

    it("resumes and re-aligns to the shared clock", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 45_000 }));
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      room.setPointer(playingPointer({ startedAtEpochMs: EPOCH - 45_000 }));
      await vi.advanceTimersByTimeAsync(0);

      const resumeIndex = invoke.names().indexOf("spotify_resume");
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
      await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      await pollTimes(1);

      const seeks = invoke.calls.filter((call) => call.cmd === "spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 22_000 });
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
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      await pollTimes(1);

      expect(invoke.names()).not.toContain("spotify_seek");
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
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0; // drop the apply-time state read

      await pollTimes(3);

      // Each poll still reads state to decide control, but nothing is reported
      // and no command is sent to the player.
      expect(room.setMyProgress).not.toHaveBeenCalled();
      expect(invoke.names().filter((n) => n !== "spotify_get_state")).toEqual([]);
      driver.stop();
    });

    it("clears progress when the pointer goes null", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      room.setPointer(NULL_POINTER);
      await vi.advanceTimersByTimeAsync(0);

      expect(room.setMyProgress).toHaveBeenCalledWith(null);
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
  });

  describe("remote seek", () => {
    it("seeks the local player when the clock moves under an unchanged item", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      // Somebody dragged the room to 90s.
      room.setPointer(playingPointer({ startedAtEpochMs: EPOCH - 90_000 }));
      await vi.advanceTimersByTimeAsync(0);

      const seeks = invoke.calls.filter((call) => call.cmd === "spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 90_000 });
      driver.stop();
    });

    it("seeks to the frozen offset when the room seeks while paused", async () => {
      const room = makeRoom(playingPointer({ isPaused: true, pausedAtOffsetMs: 10_000 }));
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setPointer(playingPointer({ isPaused: true, pausedAtOffsetMs: 90_000 }));
      await vi.advanceTimersByTimeAsync(0);

      const seeks = invoke.calls.filter((call) => call.cmd === "spotify_seek");
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual({ positionMs: 90_000 });
      driver.stop();
    });

    it("does not seek when an unrelated change leaves the clock alone", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setPointer(playingPointer()); // same item, same clock, same pause state
      await vi.advanceTimersByTimeAsync(0);

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
      await pollTimes(3); // and the poll keeps seeing a finished track

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
      await vi.advanceTimersByTimeAsync(0);

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
      await vi.advanceTimersByTimeAsync(0);

      // The old driver called room.advance(); the fake room no longer has one,
      // and nothing the driver does may reintroduce it.
      expect("advance" in room).toBe(false);
      driver.stop();
    });

    it("keeps polling a finished track without replaying it", async () => {
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
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0; // drop the initial apply

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
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(0);
  });

  it("leaves Spotify's queue alone while the room names no track", async () => {
    const room = makeRoom(NULL_POINTER);
    room.setQueue([]);
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_clear_queue")).toHaveLength(0);
    expect(invoke.of("spotify_set_next_track")).toHaveLength(0);
  });

  it("sets the next track once the room names one", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_set_next_track")[0]?.args).toEqual({ uri: NEXT_URI });
  });

  it("does not stop the player when the room is already playing", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(0);
    driver.stop();
  });

  it("takes over a playing room even while the user plays their own track", async () => {
    const room = makeRoom(playingPointer());
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_play_track")).toHaveLength(1);
    driver.stop();
  });

  it("sync() takes the player back from a detached user", async () => {
    const room = makeRoom(playingPointer());
    // Spotify never lands on the room's track: the user keeps their own music on.
    const invoke = makeInvoke(() => ownMusic());
    const driver = startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.of("spotify_play_track")).toHaveLength(1);

    // The next polls see the user's track and let go of the player.
    await pollTimes(2);
    expect(invoke.of("spotify_play_track")).toHaveLength(1);

    driver.sync();
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_play_track")).toHaveLength(2);
    expect(invoke.of("spotify_play_track")[1].args).toEqual({ uri: URI });
    driver.stop();
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
    await vi.advanceTimersByTimeAsync(0);
    await pollTimes(1);

    state = ownMusic();
    await pollTimes(2);

    expect(room.skip).not.toHaveBeenCalled();
    driver.stop();
  });
});
