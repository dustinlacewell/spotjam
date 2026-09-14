import type { Op, QueueItem } from "@spotjam/protocol";
import { describe, expect, it } from "vitest";

import { handleOp, type OpContext } from "./handle-op.ts";
import * as Room from "./room-state.ts";
import type { RoomState } from "./room-state.ts";
import { seededRng } from "./testing.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_700_000_000_000;

const ctx: OpContext = { now: NOW, rng: seededRng(7) };

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id };
}

function room(): RoomState {
  let state = Room.emptyRoom("jam");
  state = Room.join(state, ALICE, "alice");
  state = Room.join(state, BOB, "bob");
  return state;
}

function ids(state: RoomState, pubkey: string): string[] {
  return (state.members.get(pubkey)?.queue ?? []).map((item) => item.id);
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
    expect(ids(outcome.state, ALICE)).toEqual(["a1"]);
    expect(ids(outcome.state, BOB)).toEqual([]);
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
      { type: "move", roomId: "jam", fromIndex: 0, toIndex: 1 },
      { type: "shuffle", roomId: "jam" },
    ];

    for (const op of alicesOps) {
      const outcome = handleOp(state, ALICE, op, ctx);
      expect(outcome.error).toBeUndefined();
      expect(ids(outcome.state, BOB)).toEqual(["b1", "b2"]);
    }
  });

  it("rejects malformed op fields", () => {
    const cases: Op[] = [
      { type: "enqueue", roomId: "jam", items: [{ id: "", uri: "", trackId: "" }] },
      { type: "remove", roomId: "jam", itemId: "" },
      { type: "send-to-top", roomId: "jam", itemId: "" },
      { type: "move", roomId: "jam", fromIndex: 0.5, toIndex: 1 },
      { type: "seek", roomId: "jam", positionMs: Number.NaN },
    ];

    for (const op of cases) {
      expect(handleOp(room(), ALICE, op, ctx).error).toBe("malformed");
    }
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

  it("accepts report-progress without moving the pointer", () => {
    let state = room();
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.advance(state, NOW);

    const outcome = handleOp(state, ALICE, {
      type: "report-progress",
      roomId: "jam",
      positionMs: 12_345,
    }, ctx);

    expect(outcome.error).toBeUndefined();
    expect(outcome.state.pointer).toEqual(state.pointer);
  });

  it("leaves membership ops to the shell", () => {
    const state = room();
    for (const op of [
      { type: "join-room", roomId: "jam" },
      { type: "leave-room", roomId: "jam" },
    ] satisfies Op[]) {
      const outcome = handleOp(state, ALICE, op, ctx);
      expect(outcome.state).toBe(state);
      expect(outcome.error).toBeUndefined();
    }
  });
});
