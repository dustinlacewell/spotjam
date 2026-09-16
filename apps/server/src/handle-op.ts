// Op handling — validate, enforce ownership, apply the transition.
//
// The envelope's pubkey is the author, so ownership needs no check against the
// payload: every queue op is applied to the author's own queue and the room id
// is the only thing a client gets to choose. An op that named someone else's
// queue could not express it — there is no field for it.

import type {
  ErrorEvent,
  Op,
  PlaylistTrack,
  QueueItem,
  SharedPlaylist,
} from "@spotjam/protocol";

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
 *
 * Every op runs between two settlements. Before: the room is caught up to now,
 * because nobody reports that a track ended and the op must land on the track
 * that is really playing. After: the server, not a client, decides when a room
 * with a broadcaster and a queue starts playing. Doing both here rather than
 * per-op means no future op can forget to.
 */
export function handleOp(
  state: RoomState,
  pubkey: string,
  op: Op,
  ctx: OpContext,
): OpOutcome {
  if (!state.members.has(pubkey)) return { state, error: "not-in-room" };

  const settled = Room.settle(state, ctx.now);
  const outcome = applyOp(settled, pubkey, op, ctx);
  if (outcome.error !== undefined) return outcome;
  return { state: Room.settleStart(outcome.state, ctx.now) };
}

/** The op's own transition, before playback settles. */
function applyOp(
  state: RoomState,
  pubkey: string,
  op: Op,
  ctx: OpContext,
): OpOutcome {
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

    case "move-many":
      if (
        !Array.isArray(op.itemIds) ||
        op.itemIds.length === 0 ||
        !op.itemIds.every(isNonEmptyString) ||
        (op.beforeItemId !== null && !isNonEmptyString(op.beforeItemId))
      ) {
        return malformed(state);
      }
      return { state: Room.moveMany(state, pubkey, op.itemIds, op.beforeItemId) };

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

    case "set-public-playlists": {
      if (!Array.isArray(op.playlists) || !op.playlists.every(isSharedPlaylist)) {
        return malformed(state);
      }
      return { state: Room.setPublicPlaylists(state, pubkey, op.playlists) };
    }

    case "view-playlists":
      // A read, answered to the asker alone. The shell handles it before the
      // state path, so reaching here would change nothing anyway.
      return { state };
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

/**
 * A real track length, in whole ms.
 *
 * The server advances the pointer on this number alone, so a missing, zero, or
 * fractional one is not a cosmetic flaw: it would stall the room or leave the
 * clock chasing a boundary it can never land on. Refuse it at the door.
 */
function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isQueueItem(value: unknown): value is QueueItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.id) &&
    isNonEmptyString(item.uri) &&
    isNonEmptyString(item.trackId) &&
    isDuration(item.durationMs)
  );
}

function isPlaylistTrack(value: unknown): value is PlaylistTrack {
  if (typeof value !== "object" || value === null) return false;
  const track = value as Record<string, unknown>;
  return (
    isNonEmptyString(track.uri) &&
    isNonEmptyString(track.trackId) &&
    isDuration(track.durationMs)
  );
}

function isSharedPlaylist(value: unknown): value is SharedPlaylist {
  if (typeof value !== "object" || value === null) return false;
  const playlist = value as Record<string, unknown>;
  return (
    isNonEmptyString(playlist.id) &&
    typeof playlist.name === "string" &&
    Array.isArray(playlist.tracks) &&
    playlist.tracks.every(isPlaylistTrack)
  );
}
