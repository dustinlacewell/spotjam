// The Room contract, as a runnable suite.
//
// Any implementation of the `Room` port can be held to it: hand the factory a
// harness and every rule below is checked through the interface alone. Nothing
// here reaches inside an implementation, so a socket-backed room and an
// in-memory one are judged by the same observable behaviour.

import { describe, expect, it } from "vitest";

import type { QueueItem } from "@spotjam/protocol";

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

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id };
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

      it("advances myProgress as the clock runs", () => {
        withRoom(({ room, advanceClock }) => {
          const start = room.myProgress()?.positionMs ?? 0;
          advanceClock(5_000);
          expect(room.myProgress()?.positionMs).toBe(start + 5_000);
        });
      });

      it("freezes myProgress while paused", () => {
        withRoom(({ room, advanceClock }) => {
          advanceClock(3_000);
          room.setPaused(true);
          const frozen = room.myProgress()?.positionMs;

          advanceClock(10_000);
          expect(room.myProgress()?.positionMs).toBe(frozen);
        });
      });

      it("resumes from where it paused", () => {
        withRoom(({ room, advanceClock }) => {
          advanceClock(3_000);
          room.setPaused(true);
          const frozen = room.myProgress()?.positionMs ?? 0;

          advanceClock(10_000);
          room.setPaused(false);
          expect(room.myProgress()?.positionMs).toBe(frozen);

          advanceClock(1_000);
          expect(room.myProgress()?.positionMs).toBe(frozen + 1_000);
        });
      });

      it("moves myProgress to the seeked position", () => {
        withRoom(({ room }) => {
          room.seekTo(42_000);
          expect(room.myProgress()?.positionMs).toBe(42_000);
        });
      });

      it("keeps a seek while paused", () => {
        withRoom(({ room, advanceClock }) => {
          room.setPaused(true);
          room.seekTo(20_000);
          advanceClock(5_000);
          expect(room.myProgress()?.positionMs).toBe(20_000);
        });
      });

      it("reports progress for the item the pointer names", () => {
        withRoom(({ room }) => {
          expect(room.myProgress()?.itemId).toBe(room.getPlaybackPointer().itemId);
        });
      });
    });
  });
}
