import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncDriver } from "./sync-driver";
import type { PlayerState } from "./sync-driver";
import type { PlaybackPointer, Room, SessionEntry } from "./room";

const URI = "spotify:track:x";
const EPOCH = 1_700_000_000_000;

function playingPointer(overrides: Partial<PlaybackPointer> = {}): PlaybackPointer {
  return {
    itemId: "i1",
    ownerId: "a",
    uri: URI,
    startedAtEpochMs: EPOCH,
    isPaused: false,
    pausedAtOffsetMs: 0,
    ...overrides,
  };
}

const NULL_POINTER: PlaybackPointer = {
  itemId: null,
  ownerId: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

const NEXT_URI = "spotify:track:y";

function entry(id: string, uri: string): SessionEntry {
  return {
    item: { id, uri, trackId: id, addedBy: "a" },
    ownerId: "a",
    ownerName: "alice",
  };
}

/** The slice of Room that SyncDriver actually touches, plus test controls. */
function makeRoom(pointer: PlaybackPointer) {
  const listeners = new Set<() => void>();
  let queue: SessionEntry[] = [entry("i2", NEXT_URI)];
  const fake = {
    doc: { clientID: 1 },
    connectedClientIds: () => [1],
    sessionQueue: (): SessionEntry[] => queue,
    getPlaybackPointer: () => pointer,
    advance: vi.fn(),
    setMyProgress: vi.fn(),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Replaces the pointer and notifies the driver, as a real doc update would. */
    setPointer(next: PlaybackPointer) {
      pointer = next;
      for (const listener of listeners) listener();
    },
    /** Replaces the session queue and notifies the driver, as a real doc update would. */
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

  describe("track-end detection", () => {
    it("does not advance while Spotify has never reported our track", async () => {
      const room = makeRoom(playingPointer());
      let state: PlayerState = {
        trackUri: "spotify:track:other",
        trackName: "other",
        isPaused: false,
        positionMs: 10_000,
        durationMs: 200_000,
      };
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(5); // 10s of mismatch
      expect(room.advance).not.toHaveBeenCalled();

      // Spotify finally lands on our track.
      state = { ...state, trackUri: URI, positionMs: 1000 };
      await pollTimes(1);
      expect(room.advance).not.toHaveBeenCalled();

      // Now a mismatch really is the track ending.
      state = { ...state, trackUri: "spotify:track:next" };
      await pollTimes(1);
      expect(room.advance).toHaveBeenCalledTimes(1);

      driver.stop();
    });

    it("re-arms the latch when a new item is applied", async () => {
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

      room.setPointer(playingPointer({ itemId: "i2", uri: "spotify:track:z" }));
      await vi.advanceTimersByTimeAsync(0);

      // Spotify still reports the OLD track: a slow play command, not a track end.
      state = { ...state, trackUri: URI };
      await pollTimes(3);
      expect(room.advance).not.toHaveBeenCalled();

      driver.stop();
    });
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

    it("clears Spotify's queue when the pointer goes null with nothing queued", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      room.setQueue([]);
      await vi.advanceTimersByTimeAsync(0);
      invoke.calls.length = 0;

      room.setPointer(NULL_POINTER);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).toContain("spotify_pause");
      expect(invoke.of("spotify_clear_queue")).toHaveLength(1);
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

    it("follows Spotify into the queued track, keeping its position", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // observedOnTrack = true
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      await pollTimes(1);

      expect(room.advance).toHaveBeenCalledTimes(1);
      expect(room.advance).toHaveBeenCalledWith(EPOCH + 4000, 800);
      driver.stop();
    });

    it("does not advance a second time from the fallback timer", async () => {
      const room = makeRoom(playingPointer());
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      await pollTimes(1);
      expect(room.advance).toHaveBeenCalledTimes(1);

      // The room really moved on: the head is consumed and the pointer follows.
      // The old item's fallback timer must not fire behind it.
      room.setQueue([]);
      room.setPointer(
        playingPointer({ itemId: "i2", uri: NEXT_URI, startedAtEpochMs: EPOCH + 3200 }),
      );
      await vi.advanceTimersByTimeAsync(25_000);

      expect(room.advance).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("does not advance on a peer that is not elected", async () => {
      const room = makeRoom(playingPointer());
      room.connectedClientIds = () => [0, 1];
      let state = onOurTrack();
      const invoke = makeInvoke(() => state);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      state = { ...state, trackUri: NEXT_URI, positionMs: 800 };
      await pollTimes(1);

      expect(room.advance).not.toHaveBeenCalled();
      driver.stop();
    });

    it("falls back to the end timer when Spotify never transitions", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => onOurTrack());
      const driver = startDriver(room, invoke);

      await pollTimes(1); // aimed at EPOCH + 31_500
      await vi.advanceTimersByTimeAsync(29_499);
      expect(room.advance).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(room.advance).toHaveBeenCalledTimes(1);
      driver.stop();
    });
  });

  describe("empty pointer", () => {
    it("pauses Spotify when the pointer goes null after a played item", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke.names()).toContain("spotify_play_track");

      room.setPointer(NULL_POINTER);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).toContain("spotify_pause");
      driver.stop();
    });

    it("pauses on the first apply, so joining a quiet room silences the player", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.names()).toContain("spotify_pause");
      driver.stop();
    });

    it("pauses only once while the room stays empty", async () => {
      const room = makeRoom(NULL_POINTER);
      const invoke = makeInvoke(() => null);
      const driver = startDriver(room, invoke);
      await vi.advanceTimersByTimeAsync(0);

      room.setQueue([]);
      await vi.advanceTimersByTimeAsync(0);

      expect(invoke.of("spotify_pause")).toHaveLength(1);
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
        "spotify_get_state",
        "spotify_play_track",
        "spotify_seek",
        "spotify_pause",
        "spotify_set_next_track",
      ]);
      expect(invoke.calls[2].args).toEqual({ positionMs: 45_000 });
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

      expect(room.setMyProgress).not.toHaveBeenCalled();
      expect(invoke.names()).not.toContain("spotify_get_state");
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

  describe("precise end timer", () => {
    const track: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 2000,
      durationMs: 30_000,
    };

    it("advances 1.5s after the shared clock reaches the track's end", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // schedules for EPOCH + 31_500
      await vi.advanceTimersByTimeAsync(29_499); // now EPOCH + 31_499
      expect(room.advance).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(room.advance).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("does not advance when the room pauses before the end", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      room.setPointer(playingPointer({ isPaused: true, pausedAtOffsetMs: 3000 }));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(room.advance).not.toHaveBeenCalled();
      driver.stop();
    });

    it("does not advance when this peer is not elected", async () => {
      const room = makeRoom(playingPointer());
      room.connectedClientIds = () => [0, 1];
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1);
      await vi.advanceTimersByTimeAsync(31_500);

      expect(room.advance).not.toHaveBeenCalled();
      driver.stop();
    });

    it("reschedules when a seek moves the start of the track", async () => {
      const room = makeRoom(playingPointer());
      const invoke = makeInvoke(() => track);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // aimed at EPOCH + 31_500

      // Seek back 10s: the track now ends 10s later.
      room.setPointer(playingPointer({ startedAtEpochMs: EPOCH + 10_000 }));
      await pollTimes(1); // re-aims at EPOCH + 41_500

      await vi.advanceTimersByTimeAsync(37_499); // now EPOCH + 41_499
      expect(room.advance).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(room.advance).toHaveBeenCalledTimes(1);
      driver.stop();
    });
  });

  describe("duration end-signal", () => {
    const shortTrack: PlayerState = {
      trackUri: URI,
      trackName: "x",
      isPaused: false,
      positionMs: 10_000,
      durationMs: 10_000,
    };

    it("advances once the shared clock passes duration + 3s", async () => {
      // Started 12s ago: under duration + 3000 at the first poll, over it later.
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 12_000 }));
      const invoke = makeInvoke(() => shortTrack);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // now = EPOCH + 2000, elapsed 14_000 > 13_000

      expect(room.advance).toHaveBeenCalledTimes(1);
      driver.stop();
    });

    it("does not advance while still inside duration + 3s", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 5000 }));
      const invoke = makeInvoke(() => shortTrack);
      const driver = startDriver(room, invoke);

      await pollTimes(1); // elapsed 7000 < 13_000

      expect(room.advance).not.toHaveBeenCalled();
      driver.stop();
    });

    it("does not advance when this peer is not elected", async () => {
      const room = makeRoom(playingPointer({ startedAtEpochMs: EPOCH - 12_000 }));
      room.connectedClientIds = () => [0, 1];
      const invoke = makeInvoke(() => shortTrack);
      const driver = startDriver(room, invoke);

      await pollTimes(1);

      expect(room.advance).not.toHaveBeenCalled();
      driver.stop();
    });

    it("does not advance while the room is paused", async () => {
      const room = makeRoom(
        playingPointer({ startedAtEpochMs: EPOCH - 60_000, isPaused: true, pausedAtOffsetMs: 5000 }),
      );
      const invoke = makeInvoke(() => shortTrack);
      const driver = startDriver(room, invoke);

      await pollTimes(3);

      expect(room.advance).not.toHaveBeenCalled();
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

  it("stops the local player when nothing is playing", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(1);
  });

  it("clears Spotify's queue when nothing is queued", async () => {
    const room = makeRoom(NULL_POINTER);
    room.setQueue([]);
    const invoke = makeInvoke(() => null);
    startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_clear_queue")).not.toHaveLength(0);
    expect(invoke.of("spotify_set_next_track")).toHaveLength(0);
  });

  it("sets the next track when the queue is not empty", async () => {
    const room = makeRoom(NULL_POINTER);
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

describe("silencing the local player on an empty room", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function playing(): PlayerState {
    return {
      trackUri: "spotify:track:leftover",
      trackName: "leftover",
      isPaused: false,
      positionMs: 30_000,
      durationMs: 200_000,
    };
  }

  it("pauses a player that was left playing before the join", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => playing());
    const driver = startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(1);
    driver.stop();
  });

  it("leaves an already-paused player alone", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => ({ ...playing(), isPaused: true }));
    const driver = startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(0);
    driver.stop();
  });

  it("pauses when the player state cannot be read", async () => {
    const room = makeRoom(NULL_POINTER);
    const invoke = makeInvoke(() => null);
    const driver = startDriver(room, invoke);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.of("spotify_pause")).toHaveLength(1);
    driver.stop();
  });
});
