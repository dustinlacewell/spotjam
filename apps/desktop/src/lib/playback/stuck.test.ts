import { describe, expect, it } from "vitest";
import type { Command } from "./commands";
import {
  dropStuck,
  freshStuck,
  isStuck,
  recordExpired,
  recordSuccess,
  STUCK_AFTER,
  STUCK_TTL_MS,
  stuckTargets,
  type StuckState,
} from "./stuck";

const A: Command = { kind: "play", uri: "spotify:track:a" };
const B: Command = { kind: "play", uri: "spotify:track:b" };

const T0 = 1_000_000;

function failTimes(times: number, command: Command = A, at = T0): StuckState {
  let state = freshStuck();
  for (let i = 0; i < times; i += 1) state = recordExpired(state, [command], at);
  return state;
}

describe("stuck", () => {
  it("starts with nothing given up on", () => {
    expect(isStuck(freshStuck(), A, T0)).toBe(false);
    expect(stuckTargets(freshStuck(), T0)).toEqual([]);
  });

  it("gives up only after the limit", () => {
    expect(isStuck(failTimes(STUCK_AFTER - 1), A, T0)).toBe(false);
    expect(isStuck(failTimes(STUCK_AFTER), A, T0)).toBe(true);
  });

  it("counts each target on its own", () => {
    const state = recordExpired(failTimes(STUCK_AFTER), [B], T0);
    expect(isStuck(state, A, T0)).toBe(true);
    expect(isStuck(state, B, T0)).toBe(false);
  });

  it("does not spread a verdict to a different kind of command", () => {
    expect(isStuck(failTimes(STUCK_AFTER), { kind: "pause" }, T0)).toBe(false);
  });

  it("forgets the count once the target works", () => {
    const state = recordSuccess(failTimes(STUCK_AFTER), [A]);
    expect(isStuck(state, A, T0)).toBe(false);
  });

  it("drops only the stuck commands", () => {
    const state = failTimes(STUCK_AFTER);
    expect(dropStuck(state, [A, B, { kind: "pause" }], T0)).toEqual([B, { kind: "pause" }]);
  });

  it("keeps everything when nothing is stuck", () => {
    expect(dropStuck(freshStuck(), [A, B], T0)).toEqual([A, B]);
  });

  it("lists what it gave up on, sorted", () => {
    let state = failTimes(STUCK_AFTER, B);
    for (let i = 0; i < STUCK_AFTER; i += 1) state = recordExpired(state, [A], T0);
    expect(stuckTargets(state, T0)).toEqual(["play:spotify:track:a", "play:spotify:track:b"]);
  });

  it("is unchanged by recording nothing", () => {
    const state = failTimes(2);
    expect(recordExpired(state, [], T0)).toBe(state);
    expect(recordSuccess(state, [])).toBe(state);
    expect(recordSuccess(state, [B])).toBe(state);
  });

  describe("a verdict does not stand forever", () => {
    it("lapses once it is old enough", () => {
      const state = failTimes(STUCK_AFTER);
      expect(isStuck(state, A, T0 + STUCK_TTL_MS - 1)).toBe(true);
      expect(isStuck(state, A, T0 + STUCK_TTL_MS)).toBe(false);
    });

    it("drops out of the reported set when it lapses", () => {
      const state = failTimes(STUCK_AFTER);
      expect(stuckTargets(state, T0 + STUCK_TTL_MS)).toEqual([]);
    });

    it("issues the command again once the verdict lapses", () => {
      const state = failTimes(STUCK_AFTER);
      expect(dropStuck(state, [A], T0 + STUCK_TTL_MS)).toEqual([A]);
    });

    it("counts from one again after a gap, not from the stale total", () => {
      // Four failures long ago plus one now is not five in a row.
      const old = failTimes(STUCK_AFTER - 1);
      const state = recordExpired(old, [A], T0 + STUCK_TTL_MS);
      expect(isStuck(state, A, T0 + STUCK_TTL_MS)).toBe(false);
    });

    it("keeps counting while the failures keep coming", () => {
      // Each failure renews the clock, so a steady stream still condemns it.
      let state = freshStuck();
      for (let i = 0; i < STUCK_AFTER; i += 1) {
        state = recordExpired(state, [A], T0 + i * (STUCK_TTL_MS - 1000));
      }
      expect(isStuck(state, A, T0 + (STUCK_AFTER - 1) * (STUCK_TTL_MS - 1000))).toBe(true);
    });
  });
});
