// Op handling — validate, enforce ownership, apply the transition.
//
// The envelope's pubkey is the author, so ownership needs no check against the
// payload: every queue op is applied to the author's own queue and the room id
// is the only thing a client gets to choose. An op that named someone else's
// queue could not express it — there is no field for it.

import type { ErrorEvent, Op, QueueItem } from "@spotjam/protocol";

import type { Rng } from "./ports.ts";
import * as Room from "./room-state.ts";
import type { RoomState } from "./room-state.ts";

export type ErrorCode = ErrorEvent["code"];

export interface OpContext {
  now: number;
  rng: Rng;
}

export interface OpOutcome {
  state: RoomState;
  error?: ErrorCode;
}

/**
 * Apply one op to the room the author is in.
 *
 * The caller has already established that `pubkey` is a member of `state`;
 * routing an op to the right room is the shell's job, not this one's.
 */
export function handleOp(
  state: RoomState,
  pubkey: string,
  op: Op,
  ctx: OpContext,
): OpOutcome {
  if (!state.members.has(pubkey)) return { state, error: "not-in-room" };

  switch (op.type) {
    case "join-room":
    case "leave-room":
      // Membership is a connection-level concern; the shell owns it.
      return { state };

    case "set-broadcasting":
      if (typeof op.broadcasting !== "boolean") return malformed(state);
      return { state: Room.setBroadcasting(state, pubkey, op.broadcasting) };

    case "enqueue": {
      if (!Array.isArray(op.items) || !op.items.every(isQueueItem)) return malformed(state);
      return { state: Room.enqueue(state, pubkey, op.items) };
    }

    case "remove":
      if (!isNonEmptyString(op.itemId)) return malformed(state);
      return { state: Room.remove(state, pubkey, op.itemId) };

    case "move":
      if (!Number.isInteger(op.fromIndex) || !Number.isInteger(op.toIndex)) {
        return malformed(state);
      }
      return { state: Room.move(state, pubkey, op.fromIndex, op.toIndex) };

    case "send-to-top":
      if (!isNonEmptyString(op.itemId)) return malformed(state);
      return { state: Room.sendToTop(state, pubkey, op.itemId) };

    case "shuffle":
      return { state: Room.shuffle(state, pubkey, ctx.rng) };

    case "clear-queue":
      return { state: Room.clearQueue(state, pubkey) };

    case "set-paused":
      if (typeof op.paused !== "boolean") return malformed(state);
      return { state: Room.setPaused(state, op.paused, ctx.now) };

    case "seek":
      if (!isFinitePosition(op.positionMs)) return malformed(state);
      return { state: Room.seek(state, op.positionMs, ctx.now) };

    case "skip":
      return { state: Room.advance(state, ctx.now) };

    case "report-progress":
      // The sample never moves the pointer -- the server still owns what plays
      // and when it started. It is kept so listeners render the broadcaster's
      // real position instead of extrapolating one of their own.
      if (
        !isNonEmptyString(op.itemId) ||
        !isFinitePosition(op.positionMs) ||
        !isFinitePosition(op.durationMs) ||
        !isFinitePosition(op.sampledAtEpochMs)
      ) {
        return malformed(state);
      }
      return {
        state: Room.reportProgress(state, pubkey, {
          itemId: op.itemId,
          positionMs: op.positionMs,
          durationMs: op.durationMs,
          sampledAtEpochMs: op.sampledAtEpochMs,
        }),
      };
  }
}

function malformed(state: RoomState): OpOutcome {
  return { state, error: "malformed" };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFinitePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isQueueItem(value: unknown): value is QueueItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.id) &&
    isNonEmptyString(item.uri) &&
    isNonEmptyString(item.trackId)
  );
}
