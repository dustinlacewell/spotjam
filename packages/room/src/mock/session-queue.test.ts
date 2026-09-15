import { describe, expect, it } from "vitest";

import { NULL_POINTER, type QueueItem } from "@spotjam/protocol";

import {
  advance,
  broadcastersWithTracks,
  buildSessionQueue,
  listParticipants,
  mapQueue,
  membersInOrder,
  positionOf,
  rotate,
  seek,
  setBroadcasting,
  setPaused,
  settlePointer,
  settleStart,
  type MockMember,
  type MockState,
} from "./session-queue";

const NOW = 1_700_000_000_000;

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id };
}

function member(
  pubkey: string,
  broadcasting: boolean,
  ids: string[],
): MockMember {
  return { pubkey, username: pubkey, broadcasting, queue: ids.map(track) };
}

function state(members: MockMember[], overrides: Partial<MockState> = {}): MockState {
  return {
    members,
    order: members.map((m) => m.pubkey),
    pointer: NULL_POINTER,
    turnCursor: 0,
    ...overrides,
  };
}

describe("rotate", () => {
  it("returns an empty list unchanged", () => {
    expect(rotate([], 3)).toEqual([]);
  });

  it("moves the first `by` entries to the back", () => {
    expect(rotate([1, 2, 3], 1)).toEqual([2, 3, 1]);
  });

  it("wraps past the length", () => {
    expect(rotate([1, 2, 3], 4)).toEqual([2, 3, 1]);
  });

  it("wraps a negative offset forward", () => {
    expect(rotate([1, 2, 3], -1)).toEqual([3, 1, 2]);
  });
});

describe("membersInOrder", () => {
  it("follows `order`, not the member list", () => {
    const a = member("a", false, []);
    const b = member("b", false, []);
    const s = state([a, b], { order: ["b", "a"] });
    expect(membersInOrder(s).map((m) => m.pubkey)).toEqual(["b", "a"]);
  });

  it("gives a pubkey listed twice a single turn", () => {
    const s = state([member("a", false, [])], { order: ["a", "a"] });
    expect(membersInOrder(s)).toHaveLength(1);
  });

  it("skips an order entry with no member behind it", () => {
    const s = state([member("a", false, [])], { order: ["a", "ghost"] });
    expect(membersInOrder(s).map((m) => m.pubkey)).toEqual(["a"]);
  });
});

describe("listParticipants", () => {
  it("projects pubkey, name and broadcasting, in turn order", () => {
    const s = state([member("a", true, ["x"]), member("b", false, [])]);
    expect(listParticipants(s)).toEqual([
      { pubkey: "a", username: "a", broadcasting: true },
      { pubkey: "b", username: "b", broadcasting: false },
    ]);
  });
});

describe("buildSessionQueue", () => {
  it("is empty when nobody broadcasts", () => {
    expect(buildSessionQueue(state([member("a", false, ["x"])]))).toEqual([]);
  });

  it("interleaves broadcasters round by round", () => {
    const s = state([member("a", true, ["a1", "a2"]), member("b", true, ["b1", "b2"])]);
    expect(buildSessionQueue(s).map((entry) => entry.item.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
  });

  it("drops a member out of the rounds they cannot fill", () => {
    const s = state([member("a", true, ["a1"]), member("b", true, ["b1", "b2"])]);
    expect(buildSessionQueue(s).map((entry) => entry.item.id)).toEqual(["a1", "b1", "b2"]);
  });

  it("starts from whoever the turn cursor points at", () => {
    const s = state([member("a", true, ["a1"]), member("b", true, ["b1"])], {
      turnCursor: 1,
    });
    expect(buildSessionQueue(s).map((entry) => entry.item.id)).toEqual(["b1", "a1"]);
  });

  it("names the owner on each entry", () => {
    const s = state([member("a", true, ["a1"])]);
    expect(buildSessionQueue(s)[0]).toEqual({
      item: track("a1"),
      ownerPubkey: "a",
      ownerName: "a",
    });
  });

  it("leaves out a broadcaster with an empty queue", () => {
    const s = state([member("a", true, []), member("b", true, ["b1"])]);
    expect(buildSessionQueue(s).map((entry) => entry.item.id)).toEqual(["b1"]);
  });
});

describe("broadcastersWithTracks", () => {
  it("counts only members who both broadcast and have tracks", () => {
    const s = state([
      member("a", true, ["a1"]),
      member("b", true, []),
      member("c", false, ["c1"]),
    ]);
    expect(broadcastersWithTracks(s)).toEqual(["a"]);
  });
});

describe("mapQueue", () => {
  it("rewrites just that member's queue", () => {
    const s = state([member("a", false, ["a1"]), member("b", false, ["b1"])]);
    const next = mapQueue(s, "a", (queue) => [...queue, track("a2")]);
    expect(next.members[0].queue.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(next.members[1].queue.map((i) => i.id)).toEqual(["b1"]);
  });

  it("ignores an unknown pubkey", () => {
    const s = state([member("a", false, ["a1"])]);
    expect(mapQueue(s, "ghost", () => [])).toBe(s);
  });
});

describe("setBroadcasting", () => {
  it("flips the flag", () => {
    const s = state([member("a", false, ["a1"])]);
    expect(setBroadcasting(s, "a", true).members[0].broadcasting).toBe(true);
  });

  it("ignores an unknown pubkey", () => {
    const s = state([member("a", false, [])]);
    expect(setBroadcasting(s, "ghost", true)).toBe(s);
  });
});

describe("settlePointer", () => {
  const playing = { ...NULL_POINTER, itemId: "a1", ownerPubkey: "a", uri: "u" };

  it("clears a pointer once nobody broadcasts", () => {
    const s = state([member("a", false, [])], { pointer: playing });
    expect(settlePointer(s).pointer).toEqual(NULL_POINTER);
  });

  it("keeps the pointer while someone still broadcasts", () => {
    const s = state([member("a", true, [])], { pointer: playing });
    expect(settlePointer(s)).toBe(s);
  });

  it("does nothing when the pointer is already null", () => {
    const s = state([member("a", false, [])]);
    expect(settlePointer(s)).toBe(s);
  });
});

describe("advance", () => {
  it("takes the head of the next broadcaster's queue", () => {
    const s = state([member("a", true, ["a1", "a2"])]);
    const next = advance(s, NOW);
    expect(next.pointer).toEqual({
      itemId: "a1",
      ownerPubkey: "a",
      uri: "spotify:track:a1",
      startedAtEpochMs: NOW,
      isPaused: false,
      pausedAtOffsetMs: 0,
    });
    expect(next.members[0].queue.map((i) => i.id)).toEqual(["a2"]);
  });

  it("rotates to the other broadcaster on the second call", () => {
    const s = state([member("a", true, ["a1"]), member("b", true, ["b1"])]);
    const next = advance(advance(s, NOW), NOW);
    expect(next.pointer.itemId).toBe("b1");
    expect(next.turnCursor).toBe(2);
  });

  it("clears the pointer when nobody broadcasting has tracks", () => {
    const s = state([member("a", true, [])], {
      pointer: { ...NULL_POINTER, itemId: "old" },
    });
    expect(advance(s, NOW).pointer).toEqual(NULL_POINTER);
  });
});

describe("settleStart", () => {
  it("fills a null pointer the room can feed", () => {
    const s = state([member("a", true, ["a1"])]);
    expect(settleStart(s, NOW).pointer.itemId).toBe("a1");
  });

  it("leaves a live pointer alone", () => {
    const s = state([member("a", true, ["a1"])], {
      pointer: { ...NULL_POINTER, itemId: "other" },
    });
    expect(settleStart(s, NOW)).toBe(s);
  });

  it("does nothing when no broadcaster has tracks", () => {
    const s = state([member("a", true, [])]);
    expect(settleStart(s, NOW)).toBe(s);
  });
});

describe("setPaused", () => {
  const s = state([member("a", true, [])], {
    pointer: { ...NULL_POINTER, itemId: "a1", startedAtEpochMs: NOW },
  });

  it("freezes the elapsed offset on pause", () => {
    const next = setPaused(s, true, NOW + 4_000);
    expect(next.pointer.isPaused).toBe(true);
    expect(next.pointer.pausedAtOffsetMs).toBe(4_000);
  });

  it("rebases the start time on resume", () => {
    const paused = setPaused(s, true, NOW + 4_000);
    const next = setPaused(paused, false, NOW + 60_000);
    expect(next.pointer.startedAtEpochMs).toBe(NOW + 56_000);
    expect(next.pointer.pausedAtOffsetMs).toBe(0);
  });

  it("ignores a repeat of the current state", () => {
    expect(setPaused(s, false, NOW)).toBe(s);
  });

  it("ignores a null pointer", () => {
    const empty = state([member("a", true, [])]);
    expect(setPaused(empty, true, NOW)).toBe(empty);
  });
});

describe("seek", () => {
  const s = state([member("a", true, [])], {
    pointer: { ...NULL_POINTER, itemId: "a1", startedAtEpochMs: NOW },
  });

  it("rebases the start time while playing", () => {
    expect(seek(s, 30_000, NOW + 5_000).pointer.startedAtEpochMs).toBe(NOW - 25_000);
  });

  it("writes the frozen offset while paused", () => {
    const paused = setPaused(s, true, NOW);
    const next = seek(paused, 30_000, NOW);
    expect(next.pointer.pausedAtOffsetMs).toBe(30_000);
    expect(next.pointer.startedAtEpochMs).toBe(paused.pointer.startedAtEpochMs);
  });

  it("floors a negative position at zero", () => {
    expect(seek(s, -5_000, NOW).pointer.startedAtEpochMs).toBe(NOW);
  });

  it("ignores a null pointer", () => {
    const empty = state([member("a", true, [])]);
    expect(seek(empty, 1_000, NOW)).toBe(empty);
  });
});

describe("positionOf", () => {
  const playing = { ...NULL_POINTER, itemId: "a1", startedAtEpochMs: NOW };

  it("measures from the start time while playing", () => {
    expect(positionOf(playing, NOW + 7_000, 100_000)).toBe(7_000);
  });

  it("reads the frozen offset while paused", () => {
    const paused = { ...playing, isPaused: true, pausedAtOffsetMs: 3_000 };
    expect(positionOf(paused, NOW + 99_000, 100_000)).toBe(3_000);
  });

  it("clamps to the track's length", () => {
    expect(positionOf(playing, NOW + 500_000, 100_000)).toBe(100_000);
  });

  it("clamps a clock that ran backwards to zero", () => {
    expect(positionOf(playing, NOW - 5_000, 100_000)).toBe(0);
  });
});
