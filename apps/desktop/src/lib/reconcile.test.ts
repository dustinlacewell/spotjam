import { describe, expect, it } from "vitest";
import { freshMemo, reconcile, type Actual, type Desired, type Memo } from "./reconcile";
import type { PlayerState } from "./sync-driver";

const URI = "spotify:track:x";
const NEXT_URI = "spotify:track:y";
const NOW = 1_700_000_000_000;

function desired(overrides: Partial<Desired> = {}): Desired {
  return { uri: URI, positionMs: 10_000, isPaused: false, nextUri: NEXT_URI, ...overrides };
}

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    trackUri: URI,
    trackName: "x",
    isPaused: false,
    positionMs: 10_000,
    durationMs: 200_000,
    ...overrides,
  };
}

function actual(overrides: Partial<Actual> = {}): Actual {
  return { state: state(), queueHead: NEXT_URI, ...overrides };
}

function memoWithPlay(uri: string, at: number): Memo {
  return { ...freshMemo(), playedUri: uri, playedAt: at };
}

function memoWithSeek(positionMs: number, at: number): Memo {
  return { ...freshMemo(), seekTo: positionMs, seekAt: at };
}

describe("reconcile", () => {
  it("asks for nothing when the player already matches the room", () => {
    const { commands } = reconcile(desired(), actual(), freshMemo(), NOW);
    expect(commands).toEqual([]);
  });

  describe("track", () => {
    it("plays the room's track when Spotify is somewhere else", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: "spotify:track:other" }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });

    it("seeks after the play when the room is past the seek threshold", () => {
      const { commands } = reconcile(
        desired({ positionMs: 45_000 }),
        actual({ state: state({ trackUri: null }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([
        { kind: "play", uri: URI },
        { kind: "seek", positionMs: 45_000 },
      ]);
    });

    it("does not seek after the play when the room is near the top", () => {
      const { commands } = reconcile(
        desired({ positionMs: 1000 }),
        actual({ state: state({ trackUri: null }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });

    it("pauses after the play when the room is paused", () => {
      const { commands } = reconcile(
        desired({ positionMs: 45_000, isPaused: true }),
        actual({ state: state({ trackUri: null }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([
        { kind: "play", uri: URI },
        { kind: "seek", positionMs: 45_000 },
        { kind: "pause" },
      ]);
    });

    it("checks no drift or pause against the wrong track", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0, isPaused: true }),
        actual({ state: state({ trackUri: "spotify:track:other", isPaused: false, positionMs: 90_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }, { kind: "pause" }]);
    });

    it("does not repeat a play for the same uri inside the grace window", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: "spotify:track:other" }) }),
        memoWithPlay(URI, NOW - 1000),
        NOW,
      );
      expect(commands).toEqual([]);
    });

    it("re-plays a still-wrong track once the grace window has passed", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: "spotify:track:other" }) }),
        memoWithPlay(URI, NOW - 6000),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });

    it("plays a new uri even inside the grace window of the old one", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: "spotify:track:other" }) }),
        memoWithPlay("spotify:track:old", NOW - 1000),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });

    it("records the play in the memo", () => {
      const { memo } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: null }) }),
        freshMemo(),
        NOW,
      );
      expect(memo.playedUri).toBe(URI);
      expect(memo.playedAt).toBe(NOW);
    });
  });

  describe("pause", () => {
    it("pauses when the room paused and the player still plays", () => {
      const { commands } = reconcile(
        desired({ isPaused: true }),
        actual(),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "pause" }]);
    });

    it("resumes and re-aligns to the shared clock", () => {
      const { commands } = reconcile(
        desired({ positionMs: 45_000 }),
        actual({ state: state({ isPaused: true, positionMs: 12_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([
        { kind: "resume" },
        { kind: "seek", positionMs: 45_000 },
      ]);
    });

    it("records the resume's seek in the memo", () => {
      const { memo } = reconcile(
        desired({ positionMs: 45_000 }),
        actual({ state: state({ isPaused: true }) }),
        freshMemo(),
        NOW,
      );
      expect(memo.seekTo).toBe(45_000);
      expect(memo.seekAt).toBe(NOW);
    });
  });

  describe("drift", () => {
    it("seeks when the player is off the shared clock", () => {
      const { commands } = reconcile(
        desired({ positionMs: 22_000 }),
        actual({ state: state({ positionMs: 5000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 22_000 }]);
    });

    it("leaves a player within the drift allowance alone", () => {
      const { commands } = reconcile(
        desired({ positionMs: 11_000 }),
        actual({ state: state({ positionMs: 10_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([]);
    });

    it("never seeks while Spotify still reports position 0", () => {
      const { commands } = reconcile(
        desired({ positionMs: 22_000 }),
        actual({ state: state({ positionMs: 0 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([]);
    });

    it("does not repeat a seek inside the grace window", () => {
      const { commands } = reconcile(
        desired({ positionMs: 22_000 }),
        actual({ state: state({ positionMs: 5000 }) }),
        memoWithSeek(22_000, NOW - 1000),
        NOW,
      );
      expect(commands).toEqual([]);
    });

    it("seeks again once the grace window has passed", () => {
      const { commands } = reconcile(
        desired({ positionMs: 22_000 }),
        actual({ state: state({ positionMs: 5000 }) }),
        memoWithSeek(22_000, NOW - 6000),
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 22_000 }]);
    });
  });

  describe("queue", () => {
    it("sets the next track when Spotify's queue head differs", () => {
      const { commands } = reconcile(
        desired(),
        actual({ queueHead: "spotify:track:stale" }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "set-next", uri: NEXT_URI }]);
    });

    it("sets the next track when Spotify's queue is empty", () => {
      const { commands } = reconcile(desired(), actual({ queueHead: null }), freshMemo(), NOW);
      expect(commands).toEqual([{ kind: "set-next", uri: NEXT_URI }]);
    });

    it("clears Spotify's queue when the room has no next track", () => {
      const { commands } = reconcile(
        desired({ nextUri: null }),
        actual({ queueHead: NEXT_URI }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "clear-queue" }]);
    });

    it("leaves an already-equal queue alone", () => {
      const { commands } = reconcile(
        desired({ nextUri: null }),
        actual({ queueHead: null }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([]);
    });
  });

  // The driver ticks every 2s. These walk several ticks to pin what the rate
  // limits and the drift rule do over time, not just on one reading.
  describe("over successive ticks", () => {
    it("does not seek a second time while the track is still buffering in", () => {
      // The first tick played the track and seeked to 45s; 2s on, Spotify
      // reports the new track barely loaded while the shared clock has moved.
      const m: Memo = { playedUri: URI, playedAt: NOW, seekTo: 45_000, seekAt: NOW };
      const { commands } = reconcile(
        desired({ positionMs: 47_000 }),
        actual({ state: state({ positionMs: 500 }) }),
        m,
        NOW + 2000,
      );
      expect(commands).toEqual([]);
    });

    it("does not re-seek on a stale seek memo just because the clock moved on", () => {
      // The seek rate limit is on time alone, not on the target. The room's
      // position advances every tick, so comparing targets would never match
      // and the limit would never hold.
      const { commands } = reconcile(
        desired({ positionMs: 24_000 }),
        actual({ state: state({ positionMs: 5000 }) }),
        memoWithSeek(22_000, NOW - 2000),
        NOW,
      );
      expect(commands).toEqual([]);
    });

    it("stops chasing a player that lags the room by a constant amount", () => {
      // A slow network leaves Spotify ~3.1s behind whatever we seek to. Seeking
      // re-buffers and it comes back the same distance behind. One correction
      // is fair; a stutter every grace window forever is not.
      let m = freshMemo();
      const seeks: number[] = [];
      for (let t = 0; t <= 60_000; t += 2000) {
        const r = reconcile(
          desired({ positionMs: 100_000 + t }),
          actual({ state: state({ positionMs: 100_000 + t - 3100 }) }),
          m,
          NOW + t,
        );
        m = r.memo;
        if (r.commands.some((c) => c.kind === "seek")) seeks.push(t);
      }
      expect(seeks).toEqual([0]);
    });

    it("stops chasing a player that runs ahead of the room by a constant amount", () => {
      // The mirror of the lag case. A player that consistently reports ~3.1s
      // ahead of the shared clock is just as steady, and seeking it back
      // re-buffers it into the same place. One correction is fair; a stutter
      // every grace window forever is not.
      let m = freshMemo();
      const seeks: number[] = [];
      for (let t = 0; t <= 60_000; t += 2000) {
        const r = reconcile(
          desired({ positionMs: 100_000 + t }),
          actual({ state: state({ positionMs: 100_000 + t + 3100 }) }),
          m,
          NOW + t,
        );
        m = r.memo;
        if (r.commands.some((c) => c.kind === "seek")) seeks.push(t);
      }
      expect(seeks).toEqual([0]);
    });

    it("still corrects a real seek made while the player was lagging", () => {
      // The steady-state lag must not become a blanket excuse: somebody
      // dragging the room 40s forward moves the player far off that lag.
      const m = memoWithSeek(100_000, NOW - 6000);
      const { commands } = reconcile(
        desired({ positionMs: 146_000 }),
        actual({ state: state({ positionMs: 106_000 }) }),
        m,
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 146_000 }]);
    });

    it("corrects a small room seek that lands inside the steady-lag window", () => {
      // The ratchet reads the player against where our own seek would have
      // carried it. A room dragged back 5s puts the player 6s off that ideal —
      // a distance the ratchet would call steady — while the player is in fact
      // exactly where it was asked to be. Suppressing here leaves this listener
      // 5s out of the room until somebody seeks again.
      const m = memoWithSeek(100_000, NOW - 6000);
      const { commands } = reconcile(
        desired({ positionMs: 100_000 }),
        actual({ state: state({ positionMs: 105_000 }) }),
        m,
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 100_000 }]);
    });

    it("corrects a small room seek forwards just the same", () => {
      const m = memoWithSeek(100_000, NOW - 6000);
      const { commands } = reconcile(
        desired({ positionMs: 111_000 }),
        actual({ state: state({ positionMs: 105_000 }) }),
        m,
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 111_000 }]);
    });

    it("re-issues set-next every tick while Spotify's queue head stays wrong", () => {
      // Level-triggered on purpose. `spotify_set_next_track` is idempotent and
      // only touches user-queued items, so a repeat converges on one entry
      // rather than piling up — and a write that never landed gets another go.
      let m = freshMemo();
      let sets = 0;
      for (let t = 0; t <= 20_000; t += 2000) {
        const r = reconcile(desired(), actual({ queueHead: "spotify:track:stale" }), m, NOW + t);
        m = r.memo;
        if (r.commands.some((c) => c.kind === "set-next")) sets += 1;
      }
      expect(sets).toBe(11);
    });

    it("waits out the whole grace window before retrying a dropped play", () => {
      // Deliberate, even though the driver ticks faster: a track that is slow
      // to load looks exactly like a play that never landed, and re-issuing
      // play at 2s would restart the load it is waiting on.
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: "spotify:track:other" }) }),
        memoWithPlay(URI, NOW - 2000),
        NOW,
      );
      expect(commands).toEqual([]);
    });
  });

  describe("edges", () => {
    it("moves the local player when the room is seeked while paused", () => {
      const { commands } = reconcile(
        desired({ positionMs: 90_000, isPaused: true }),
        actual({ state: state({ isPaused: true, positionMs: 10_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "seek", positionMs: 90_000 }]);
    });

    it("queues a track the room lined up behind itself", () => {
      const { commands } = reconcile(
        desired({ nextUri: URI }),
        actual({ queueHead: null }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "set-next", uri: URI }]);
    });

    it("plays without seeking when the room's position is not positive", () => {
      const { commands } = reconcile(
        desired({ positionMs: -5000 }),
        actual({ state: state({ trackUri: null }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });

    it("plays the room's track when Spotify reports no track at all", () => {
      const { commands } = reconcile(
        desired({ positionMs: 0 }),
        actual({ state: state({ trackUri: null, durationMs: 0 }), queueHead: NEXT_URI }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "play", uri: URI }]);
    });
  });

  describe("resume", () => {
    it("does not seek when the player is already where the room is", () => {
      const { commands } = reconcile(
        desired({ positionMs: 45_000 }),
        actual({ state: state({ isPaused: true, positionMs: 45_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "resume" }]);
    });

    it("does not seek for a gap inside the drift allowance", () => {
      const { commands } = reconcile(
        desired({ positionMs: 46_000 }),
        actual({ state: state({ isPaused: true, positionMs: 45_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(commands).toEqual([{ kind: "resume" }]);
    });

    it("leaves the seek memo alone when the resume needed no seek", () => {
      const { memo } = reconcile(
        desired({ positionMs: 45_000 }),
        actual({ state: state({ isPaused: true, positionMs: 45_000 }) }),
        freshMemo(),
        NOW,
      );
      expect(memo.seekTo).toBeNull();
    });
  });
});
