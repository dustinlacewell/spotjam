import { describe, expect, it } from "vitest";
import type { Command } from "./commands";
import {
  arriving,
  expectationFor,
  holds,
  pending,
  prune,
  ROLLOVER_SLACK_MS,
  rolloverFor,
  rolloverPending,
  type Expectation,
} from "./expectations";
import type { Observation } from "./observation";

function obs(over: Partial<Observation> = {}): Observation {
  return {
    trackUri: "spotify:track:a",
    isPaused: false,
    positionMs: 10_000,
    durationMs: 200_000,
    queueHead: null,
    at: 1000,
    ...over,
  };
}

describe("expectationFor", () => {
  it.each<[Command, number]>([
    [{ kind: "play", uri: "spotify:track:a" }, 3000],
    [{ kind: "seek", positionMs: 5 }, 3000],
    [{ kind: "pause" }, 3000],
    [{ kind: "resume" }, 3000],
    [{ kind: "set-next", uri: "spotify:track:b" }, 1500],
    [{ kind: "clear-queue" }, 1500],
  ])("%o gets %d ms", (command, window) => {
    const e = expectationFor(command, 1000);
    expect(e).toEqual({ what: command, issuedAt: 1000, deadline: 1000 + window });
  });
});

describe("rolloverFor", () => {
  it("names where the player is going and where it is leaving", () => {
    const e = rolloverFor(
      obs({ trackUri: "spotify:track:a", queueHead: "spotify:track:b" }),
      1000,
    );
    expect(e.what).toEqual({
      kind: "rollover",
      uri: "spotify:track:b",
      from: "spotify:track:a",
    });
  });

  it("aims its deadline at the track's own end, on Spotify's clock", () => {
    // 40s left to run, plus the slack: our clock does not come into it.
    const e = rolloverFor(obs({ positionMs: 160_000, durationMs: 200_000, at: 5000 }), 1000);
    expect(e.deadline).toBe(5000 + 40_000 + ROLLOVER_SLACK_MS);
  });

  it("does not aim into the past for a player already past its end", () => {
    const e = rolloverFor(obs({ positionMs: 210_000, durationMs: 200_000, at: 5000 }), 1000);
    expect(e.deadline).toBe(5000 + ROLLOVER_SLACK_MS);
  });

  it("promises no particular track when the queue is empty", () => {
    const e = rolloverFor(obs({ queueHead: null }), 1000);
    expect(e.what).toMatchObject({ kind: "rollover", uri: null });
  });
});

describe("holds", () => {
  const at = (command: Command, issuedAt = 1000): Expectation =>
    expectationFor(command, issuedAt);

  it.each<[string, Command, Partial<Observation>, boolean]>([
    ["play on the asked track", { kind: "play", uri: "spotify:track:a" }, {}, true],
    [
      "play still on the old track",
      { kind: "play", uri: "spotify:track:b" },
      {},
      false,
    ],
    ["pause when paused", { kind: "pause" }, { isPaused: true }, true],
    ["pause while still playing", { kind: "pause" }, { isPaused: false }, false],
    ["resume when playing", { kind: "resume" }, { isPaused: false }, true],
    ["resume while still paused", { kind: "resume" }, { isPaused: true }, false],
    [
      "set-next on the asked track",
      { kind: "set-next", uri: "spotify:track:b" },
      { queueHead: "spotify:track:b" },
      true,
    ],
    [
      "set-next on another track",
      { kind: "set-next", uri: "spotify:track:b" },
      { queueHead: "spotify:track:c" },
      false,
    ],
    ["clear-queue on an empty slot", { kind: "clear-queue" }, { queueHead: null }, true],
    [
      "clear-queue on a full slot",
      { kind: "clear-queue" },
      { queueHead: "spotify:track:b" },
      false,
    ],
  ])("%s", (_name, command, over, expected) => {
    expect(holds(at(command), obs(over))).toBe(expected);
  });

  describe("seek", () => {
    it("holds when the player landed on the target", () => {
      const e = at({ kind: "seek", positionMs: 60_000 }, 1000);
      expect(holds(e, obs({ positionMs: 60_000, at: 1000 }))).toBe(true);
    });

    it("allows for the time a playing track has run since", () => {
      const e = at({ kind: "seek", positionMs: 60_000 }, 1000);
      // 10s later, a playing track is 10s past the target and still landed.
      expect(holds(e, obs({ positionMs: 70_000, at: 11_000 }))).toBe(true);
      expect(holds(e, obs({ positionMs: 60_000, at: 11_000 }))).toBe(false);
    });

    it("allows nothing for time on a paused track", () => {
      const e = at({ kind: "seek", positionMs: 60_000 }, 1000);
      expect(holds(e, obs({ positionMs: 60_000, at: 11_000, isPaused: true }))).toBe(true);
      expect(holds(e, obs({ positionMs: 70_000, at: 11_000, isPaused: true }))).toBe(false);
    });

    it("tolerates three seconds of slack", () => {
      const e = at({ kind: "seek", positionMs: 60_000 }, 1000);
      expect(holds(e, obs({ positionMs: 63_000, at: 1000 }))).toBe(true);
      expect(holds(e, obs({ positionMs: 63_001, at: 1000 }))).toBe(false);
    });
  });
});

describe("prune", () => {
  it("reports what landed", () => {
    const list = [expectationFor({ kind: "pause" }, 1000)];
    expect(prune(list, obs({ isPaused: true }), 1100)).toEqual({
      kept: [],
      landed: list,
      expired: [],
    });
  });

  it("keeps what is still in flight", () => {
    const list = [expectationFor({ kind: "pause" }, 1000)];
    expect(prune(list, obs({ isPaused: false }), 1100)).toEqual({
      kept: list,
      landed: [],
      expired: [],
    });
  });

  it("expires what ran out of time", () => {
    const list = [expectationFor({ kind: "pause" }, 1000)];
    expect(prune(list, obs({ isPaused: false }), 4000)).toEqual({
      kept: [],
      landed: [],
      expired: list,
    });
  });

  it("prefers landed over expired at the deadline", () => {
    const list = [expectationFor({ kind: "pause" }, 1000)];
    expect(prune(list, obs({ isPaused: true }), 99_999)).toEqual({
      kept: [],
      landed: list,
      expired: [],
    });
  });

  it("judges each entry on its own", () => {
    const play = expectationFor({ kind: "play", uri: "spotify:track:a" }, 1000);
    const pause = expectationFor({ kind: "pause" }, 1000);
    const setNext = expectationFor({ kind: "set-next", uri: "spotify:track:b" }, 1000);
    const { kept, landed, expired } = prune([play, pause, setNext], obs({ isPaused: false }), 2800);
    // play landed; pause is still in flight; the queue op ran out at 2500.
    expect(landed).toEqual([play]);
    expect(kept).toEqual([pause]);
    expect(expired).toEqual([setNext]);
  });
});

describe("holds — a rollover", () => {
  const rollover = (uri: string | null, from: string | null): Expectation => ({
    what: { kind: "rollover", uri, from },
    issuedAt: 1000,
    deadline: 9999,
  });

  it("holds when the player reached the track it named", () => {
    const e = rollover("spotify:track:b", "spotify:track:a");
    expect(holds(e, obs({ trackUri: "spotify:track:b" }))).toBe(true);
  });

  it("does not hold while the player is still on the old track", () => {
    const e = rollover("spotify:track:b", "spotify:track:a");
    expect(holds(e, obs({ trackUri: "spotify:track:a" }))).toBe(false);
  });

  it("does not hold when the player went somewhere else entirely", () => {
    // The user picking their own track is not the transition we predicted.
    const e = rollover("spotify:track:b", "spotify:track:a");
    expect(holds(e, obs({ trackUri: "spotify:track:zz" }))).toBe(false);
  });

  describe("with no known destination", () => {
    it("holds as soon as the player leaves the track it was registered on", () => {
      const e = rollover(null, "spotify:track:a");
      expect(holds(e, obs({ trackUri: "spotify:track:zz" }))).toBe(true);
      expect(holds(e, obs({ trackUri: null }))).toBe(true);
    });

    it("does not hold while the player is still on that track", () => {
      const e = rollover(null, "spotify:track:a");
      expect(holds(e, obs({ trackUri: "spotify:track:a" }))).toBe(false);
    });
  });
});

describe("arriving", () => {
  const A = "spotify:track:a";
  const B = "spotify:track:b";

  it("is true for a play of that track in flight", () => {
    expect(arriving([expectationFor({ kind: "play", uri: A }, 1000)], A)).toBe(true);
  });

  it("is true for a rollover heading to that track", () => {
    const list = [rolloverFor(obs({ trackUri: B, queueHead: A }), 1000)];
    expect(arriving(list, A)).toBe(true);
  });

  it("is false for a play or rollover aimed elsewhere", () => {
    expect(arriving([expectationFor({ kind: "play", uri: B }, 1000)], A)).toBe(false);
    expect(arriving([rolloverFor(obs({ trackUri: B, queueHead: B }), 1000)], A)).toBe(false);
  });

  it("is false for a rollover that promises no particular track", () => {
    // It only says the player will leave; it cannot vouch for where it lands.
    const list = [rolloverFor(obs({ trackUri: B, queueHead: null }), 1000)];
    expect(arriving(list, A)).toBe(false);
    expect(arriving(list, null)).toBe(false);
  });

  it("is false on an empty list", () => {
    expect(arriving([], A)).toBe(false);
  });
});

describe("rolloverPending", () => {
  const A = "spotify:track:a";

  it("finds one registered against that track", () => {
    const list = [rolloverFor(obs({ trackUri: A, queueHead: null }), 1000)];
    expect(rolloverPending(list, A)).toBe(true);
    expect(rolloverPending(list, "spotify:track:zz")).toBe(false);
  });

  it("ignores ordinary commands", () => {
    expect(rolloverPending([expectationFor({ kind: "play", uri: A }, 1000)], A)).toBe(false);
  });
});

describe("pending", () => {
  const list = [
    expectationFor({ kind: "play", uri: "spotify:track:a" }, 1000),
    expectationFor({ kind: "set-next", uri: "spotify:track:b" }, 1000),
  ];

  it.each<[Parameters<typeof pending>[1], boolean]>([
    ["play", true],
    ["set-next", true],
    ["seek", false],
    ["pause", false],
    ["resume", false],
    ["clear-queue", false],
  ])("%s -> %s", (kind, expected) => {
    expect(pending(list, kind)).toBe(expected);
  });

  it("is false on an empty list", () => {
    expect(pending([], "play")).toBe(false);
  });
});
