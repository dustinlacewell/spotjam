import type { RoomSummary } from "@spotjam/protocol";
import { describe, expect, it } from "vitest";

import { sameSummary, summarize } from "./room-summary.ts";
import * as Room from "./room-state.ts";

const base: RoomSummary = {
  roomId: "jam",
  listeners: 2,
  trackUri: "spotify:track:a1",
  createdAtEpochMs: 1_000,
};

describe("sameSummary", () => {
  it("holds for a distinct object with identical fields", () => {
    expect(sameSummary(base, { ...base })).toBe(true);
  });

  it("fails on a different room id", () => {
    expect(sameSummary(base, { ...base, roomId: "other" })).toBe(false);
  });

  it("fails on a different listener count", () => {
    expect(sameSummary(base, { ...base, listeners: 3 })).toBe(false);
  });

  it("fails on a different track", () => {
    expect(sameSummary(base, { ...base, trackUri: "spotify:track:b2" })).toBe(false);
  });

  it("distinguishes a null track from a set one", () => {
    expect(sameSummary(base, { ...base, trackUri: null })).toBe(false);
  });

  it("fails on a different creation time", () => {
    expect(sameSummary(base, { ...base, createdAtEpochMs: 2_000 })).toBe(false);
  });
});

describe("summarize", () => {
  it("counts members and reports the pointer's track", () => {
    const state = Room.join(Room.emptyRoom("jam", 1_000), "key-a", "alice");

    expect(summarize(state)).toEqual({
      roomId: "jam",
      listeners: 1,
      trackUri: null,
      createdAtEpochMs: 1_000,
    });
  });
});
