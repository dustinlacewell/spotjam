import {
  NULL_POINTER,
  type Op,
  type SharedPlaylist,
} from "@spotjam/protocol";
import { describe, expect, it } from "vitest";

import { handleOp, type OpContext } from "./handle-op.ts";
import * as Room from "./room-state.ts";
import type { RoomState } from "./room-state.ts";
import { seededRng, track, trackIds } from "./testing.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const ctx: OpContext = { now: NOW, rng: seededRng(7) };

/** The same context at a later instant. */
function at(now: number): OpContext {
  return { now, rng: seededRng(7) };
}

function room(): RoomState {
  let state = Room.emptyRoom("jam");
  state = Room.join(state, ALICE, "alice");
  state = Room.join(state, BOB, "bob");
  return state;
}

describe("handleOp", () => {
  it("refuses an op from someone not in the room", () => {
    const outcome = handleOp(Room.emptyRoom("jam"), ALICE, {
      type: "clear-queue",
      roomId: "jam",
    }, ctx);

    expect(outcome.error).toBe("not-in-room");
  });

  it("applies an enqueue to the author's own queue", () => {
    const outcome = handleOp(room(), ALICE, {
      type: "enqueue",
      roomId: "jam",
      items: [track("a1")],
    }, ctx);

    expect(outcome.error).toBeUndefined();
    expect(trackIds(outcome.state, ALICE)).toEqual(["a1"]);
    expect(trackIds(outcome.state, BOB)).toEqual([]);
  });

  it("scopes every mutation to the author, never another member", () => {
    // Ops carry no author field, so Bob's queue is unreachable from Alice's
    // ops by construction. These assertions pin that property.
    let state = room();
    state = Room.enqueue(state, BOB, [track("b1"), track("b2")]);
    state = Room.enqueue(state, ALICE, [track("a1")]);

    const alicesOps: Op[] = [
      { type: "clear-queue", roomId: "jam" },
      { type: "remove", roomId: "jam", itemId: "b1" },
      { type: "send-to-top", roomId: "jam", itemId: "b2" },
      { type: "move-many", roomId: "jam", itemIds: ["a1"], beforeItemId: null },
      { type: "shuffle", roomId: "jam" },
    ];

    for (const op of alicesOps) {
      const outcome = handleOp(state, ALICE, op, ctx);
      expect(outcome.error).toBeUndefined();
      expect(trackIds(outcome.state, BOB)).toEqual(["b1", "b2"]);
    }
  });

  it("rejects malformed op fields", () => {
    const cases: Op[] = [
      {
        type: "enqueue",
        roomId: "jam",
        items: [{ id: "", uri: "", trackId: "", durationMs: 1 }],
      },
      { type: "remove", roomId: "jam", itemId: "" },
      { type: "send-to-top", roomId: "jam", itemId: "" },
      { type: "move-many", roomId: "jam", itemIds: [], beforeItemId: null },
      { type: "move-many", roomId: "jam", itemIds: [""], beforeItemId: null },
      { type: "seek", roomId: "jam", positionMs: Number.NaN },
    ];

    for (const op of cases) {
      expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
    }
  });

  it("rejects a queue item without a usable duration", () => {
    // The server advances the pointer on this number alone. A track without one
    // would stall the room, so it never gets in.
    const cases: unknown[] = [
      { id: "a1", uri: "spotify:track:a1", trackId: "a1" },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 0 },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: -1 },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: 1.5 },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: Number.NaN },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: Number.POSITIVE_INFINITY },
      { id: "a1", uri: "spotify:track:a1", trackId: "a1", durationMs: "200000" },
    ];

    for (const item of cases) {
      const op = { type: "enqueue", roomId: "jam", items: [item] } as unknown as Op;
      expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
    }
  });

  it("rejects a playlist track without a usable duration", () => {
    const op = {
      type: "set-public-playlists",
      roomId: "jam",
      playlists: [
        { id: "p1", name: "Morning", tracks: [{ uri: "spotify:track:a1", trackId: "a1" }] },
      ],
    } as unknown as Op;

    expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
  });

  it("rejects a non-array enqueue payload", () => {
    const op = { type: "enqueue", roomId: "jam", items: "nope" } as unknown as Op;
    expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
  });

  it("sets the broadcasting flag", () => {
    const outcome = handleOp(room(), ALICE, {
      type: "set-broadcasting",
      roomId: "jam",
      broadcasting: true,
    }, ctx);

    expect(outcome.state.members.get(ALICE)?.broadcasting).toBe(true);
  });

  it("advances the pointer on skip", () => {
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);

    const outcome = handleOp(state, ALICE, { type: "skip", roomId: "jam" }, ctx);
    expect(outcome.state.pointer.itemId).toBe("a1");
  });

  it("starts playback when a broadcaster enqueues into a silent room", () => {
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);

    const outcome = handleOp(state, ALICE, {
      type: "enqueue",
      roomId: "jam",
      items: [track("a1")],
    }, ctx);

    expect(outcome.state.pointer).toMatchObject({
      itemId: "a1",
      ownerPubkey: ALICE,
      startedAtEpochMs: NOW,
    });
  });

  it("starts playback when a member with tracks starts broadcasting", () => {
    let state = room();
    state = Room.enqueue(state, ALICE, [track("a1")]);

    const outcome = handleOp(state, ALICE, {
      type: "set-broadcasting",
      roomId: "jam",
      broadcasting: true,
    }, ctx);

    expect(outcome.state.pointer.itemId).toBe("a1");
  });

  it("stays silent when the enqueuing member is not broadcasting", () => {
    const outcome = handleOp(room(), ALICE, {
      type: "enqueue",
      roomId: "jam",
      items: [track("a1")],
    }, ctx);

    expect(outcome.state.pointer).toEqual(NULL_POINTER);
  });

  it("restarts after exhaustion when a new track arrives", () => {
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.advance(state, NOW);

    // Skipping the last track empties the room; settleStart has nothing to feed.
    state = handleOp(state, ALICE, { type: "skip", roomId: "jam" }, ctx).state;
    expect(state.pointer).toEqual(NULL_POINTER);

    state = handleOp(state, ALICE, {
      type: "enqueue",
      roomId: "jam",
      items: [track("a2")],
    }, ctx).state;
    expect(state.pointer.itemId).toBe("a2");
  });

  it("catches the room up before the op lands", () => {
    // No client says a track ended, so an op arriving after the end must act on
    // the track that is really playing -- here, pausing a2 rather than a1.
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1", MINUTE), track("a2", 5 * MINUTE)]);
    state = Room.advance(state, NOW);

    const outcome = handleOp(
      state,
      ALICE,
      { type: "set-paused", roomId: "jam", paused: true },
      at(NOW + MINUTE + 10_000),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.state.pointer).toMatchObject({
      itemId: "a2",
      isPaused: true,
      // a2 started at a1's exact end, so it is 10s in, not 70s.
      pausedAtOffsetMs: 10_000,
    });
  });

  it("settles even when the op is refused", () => {
    // The clock moved regardless of what the client sent.
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1", MINUTE), track("a2", 5 * MINUTE)]);
    state = Room.advance(state, NOW);

    const outcome = handleOp(
      state,
      ALICE,
      { type: "remove", roomId: "jam", itemId: "" },
      at(NOW + MINUTE),
    );

    expect(outcome.error).toBe("malformed");
    expect(outcome.state.pointer.itemId).toBe("a2");
  });

  it("stores well-formed public playlists", () => {
    const playlists: SharedPlaylist[] = [
      {
        id: "p1",
        name: "Morning",
        tracks: [{ uri: "spotify:track:a1", trackId: "a1", durationMs: 200_000 }],
      },
      { id: "p2", name: "", tracks: [] },
    ];

    const outcome = handleOp(room(), ALICE, {
      type: "set-public-playlists",
      roomId: "jam",
      playlists,
    }, ctx);

    expect(outcome.error).toBeUndefined();
    expect(Room.publicPlaylistsOf(outcome.state, ALICE)).toEqual(playlists);
    expect(Room.publicPlaylistsOf(outcome.state, BOB)).toEqual([]);
  });

  it("rejects malformed public playlists", () => {
    const cases: unknown[] = [
      "nope",
      [{ name: "Morning", tracks: [] }],
      [{ id: "p1", tracks: [] }],
      [{ id: "p1", name: 7, tracks: [] }],
      [{ id: "p1", name: "Morning" }],
      [{ id: "p1", name: "Morning", tracks: "nope" }],
      [{ id: "p1", name: "Morning", tracks: [{ uri: "spotify:track:a1" }] }],
      [{ id: "p1", name: "Morning", tracks: [{ uri: "", trackId: "a1", durationMs: 1 }] }],
      [null],
    ];

    for (const playlists of cases) {
      const op = { type: "set-public-playlists", roomId: "jam", playlists } as unknown as Op;
      expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
    }
  });
});
