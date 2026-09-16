// The Room contract, as a runnable suite.
//
// Any implementation of the `Room` port can be held to it: hand the factory a
// harness and every rule below is checked through the interface alone. Nothing
// here reaches inside an implementation, so a socket-backed room and an
// in-memory one are judged by the same observable behaviour.

import { describe, expect, it } from "vitest";

import { positionAt, type QueueItem } from "@spotjam/protocol";

import type { Room } from "./room";

/** One implementation, ready to test, plus the controls a test needs. */
export interface RoomHarness {
  room: Room;
  /** The room's own pubkey. */
  me: string;
  /** Another participant, whose queue is not mine. */
  other: string;
  /** Move the room's clock forward, so progress can be observed. */
  advanceClock(ms: number): void;
  /** Release anything the harness holds. */
  destroy?(): void;
}

/** Long enough that the clock nudges below never run a seeded track out. */
const TRACK_MS = 600_000;

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id, durationMs: TRACK_MS };
}

const A = track("a");
const B = track("b");
const C = track("c");
const D = track("d");

/**
 * Assert that `make()` produces a room obeying the port.
 *
 * Call it from a test file: `describeRoomContract("MockRoom", () => …)`.
 */
export function describeRoomContract(name: string, make: () => RoomHarness): void {
  describe(`${name} — Room contract`, () => {
    /** Runs a body against a fresh harness and always tears it down. */
    function withRoom(body: (harness: RoomHarness) => void): void {
      const harness = make();
      try {
        body(harness);
      } finally {
        harness.destroy?.();
      }
    }

    /**
     * As `withRoom`, but starting from an empty queue.
     *
     * A harness may seed tracks; the queue rules below are about what an op
     * does, not about what the seed held, so they start from a known floor.
     */
    function withEmptyQueue(body: (harness: RoomHarness) => void): void {
      withRoom((harness) => {
        harness.room.clearMyQueue();
        expect(harness.room.myQueue()).toEqual([]);
        body(harness);
      });
    }

    describe("queue reads and writes", () => {
      it("shows an appended item in my queue", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B]);
          expect(room.myQueue().map((item) => item.id)).toEqual(["a", "b"]);
        });
      });

      it("drops a removed item", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B, C]);
          room.removeFromMyQueue("b");
          expect(room.myQueue().map((item) => item.id)).toEqual(["a", "c"]);
        });
      });

      it("moves a block of items together, keeping their relative order", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B, C, D]);
          room.moveManyInMyQueue(["d", "b"], "a");
          expect(room.myQueue().map((item) => item.id)).toEqual(["b", "d", "a", "c"]);
        });
      });

      it("moves a block to the end when beforeItemId is null", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B, C, D]);
          room.moveManyInMyQueue(["a", "c"], null);
          expect(room.myQueue().map((item) => item.id)).toEqual(["b", "d", "a", "c"]);
        });
      });

      it("lifts an item to the front on sendToTop", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B, C]);
          room.sendToTopOfMyQueue("c");
          expect(room.myQueue().map((item) => item.id)).toEqual(["c", "a", "b"]);
        });
      });

      it("empties my queue on clear", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B]);
          room.clearMyQueue();
          expect(room.myQueue()).toEqual([]);
        });
      });

      it("swaps the whole queue on replace", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B]);
          room.replaceMyQueue([C]);
          expect(room.myQueue().map((item) => item.id)).toEqual(["c"]);
        });
      });

      it("keeps the same items when shuffling", () => {
        withEmptyQueue(({ room }) => {
          room.appendToMyQueue([A, B, C]);
          room.shuffleMyQueue();
          expect([...room.myQueue().map((item) => item.id)].sort()).toEqual(["a", "b", "c"]);
        });
      });

      it("keeps another participant's queue separate from mine", () => {
        withEmptyQueue(({ room, other }) => {
          const theirs = room.queueOf(other).map((item) => item.id);
          room.appendToMyQueue([A, B, C]);
          expect(room.queueOf(other).map((item) => item.id)).toEqual(theirs);
          expect(room.queueOf(room.myPubkey)).toEqual(room.myQueue());
        });
      });
    });

    describe("participants", () => {
      it("reflects broadcasting in participants() and isBroadcasting()", () => {
        withRoom(({ room, me }) => {
          room.setBroadcasting(true);
          expect(room.participants().find((p) => p.pubkey === me)?.broadcasting).toBe(true);
          expect(room.isBroadcasting()).toBe(true);

          room.setBroadcasting(false);
          expect(room.participants().find((p) => p.pubkey === me)?.broadcasting).toBe(false);
          expect(room.isBroadcasting()).toBe(false);
        });
      });

      it("lists me among the participants", () => {
        withRoom(({ room, me }) => {
          expect(room.participants().map((p) => p.pubkey)).toContain(me);
        });
      });
    });

    describe("subscriptions", () => {
      it("fires onChange for a mutation and stops after unsubscribe", () => {
        withRoom(({ room }) => {
          let changes = 0;
          const unsubscribe = room.onChange(() => {
            changes += 1;
          });

          room.appendToMyQueue([A]);
          expect(changes).toBeGreaterThan(0);

          const seen = changes;
          unsubscribe();
          room.appendToMyQueue([B]);
          expect(changes).toBe(seen);
        });
      });

      it("hands a new status listener the current status", () => {
        withRoom(({ room }) => {
          const seen: unknown[] = [];
          const unsubscribe = room.onStatus((status) => seen.push(status));
          expect(seen).toEqual([room.getStatus()]);
          unsubscribe();
        });
      });

      it("reports no error on a healthy room", () => {
        withRoom(({ room }) => {
          expect(room.lastError()).toBeNull();
        });
      });
    });

    describe("playback", () => {
      it("moves the pointer off the current item on skip", () => {
        withRoom(({ room }) => {
          const before = room.getPlaybackPointer().itemId;
          expect(before).not.toBeNull();

          room.skip();
          expect(room.getPlaybackPointer().itemId).not.toBe(before);
        });
      });

      /** Where the pointer sits, read on the room's own server clock. */
      function positionOf(room: Room): number {
        return positionAt(room.getPlaybackPointer(), room.serverNow());
      }

      it("advances the pointer's position as the clock runs", () => {
        withRoom((harness) => {
          const start = positionOf(harness.room);
          harness.advanceClock(5_000);
          expect(positionOf(harness.room)).toBe(start + 5_000);
        });
      });

      it("freezes the position while paused", () => {
        withRoom((harness) => {
          harness.advanceClock(3_000);
          harness.room.setPaused(true);
          const frozen = positionOf(harness.room);

          harness.advanceClock(10_000);
          expect(positionOf(harness.room)).toBe(frozen);
        });
      });

      it("resumes from where it paused", () => {
        withRoom((harness) => {
          harness.advanceClock(3_000);
          harness.room.setPaused(true);
          const frozen = positionOf(harness.room);

          harness.advanceClock(10_000);
          harness.room.setPaused(false);
          expect(positionOf(harness.room)).toBe(frozen);

          harness.advanceClock(1_000);
          expect(positionOf(harness.room)).toBe(frozen + 1_000);
        });
      });

      it("moves the position to the seeked point", () => {
        withRoom(({ room }) => {
          room.seekTo(42_000);
          expect(positionOf(room)).toBe(42_000);
        });
      });

      it("keeps a seek while paused", () => {
        withRoom((harness) => {
          harness.room.setPaused(true);
          harness.room.seekTo(20_000);
          harness.advanceClock(5_000);
          expect(positionOf(harness.room)).toBe(20_000);
        });
      });

      it("carries the playing track's length on the pointer", () => {
        withRoom(({ room }) => {
          expect(room.getPlaybackPointer().durationMs).toBeGreaterThan(0);
        });
      });
    });

    describe("the server clock", () => {
      it("tracks the room's own clock as it advances", () => {
        withRoom((harness) => {
          const before = harness.room.serverNow();
          harness.advanceClock(7_000);
          expect(harness.room.serverNow()).toBe(before + 7_000);
        });
      });

      it("reads the pointer's start time in the same frame", () => {
        // The pointer is stamped in server time, so a position read against
        // serverNow() must land inside the track rather than an epoch away.
        withRoom(({ room }) => {
          const position = positionAt(room.getPlaybackPointer(), room.serverNow());
          expect(position).toBeGreaterThanOrEqual(0);
          expect(position).toBeLessThanOrEqual(room.getPlaybackPointer().durationMs);
        });
      });
    });
  });
}
