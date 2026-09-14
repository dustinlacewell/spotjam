import { describe, expect, it } from "vitest";
import { broadcasterOrder, projectSessionQueue } from "./session-queue";
import type { Participant, QueueItem } from "./room";

function participant(clientId: number, userId: string, broadcasting: boolean): Participant {
  return { clientId, userId, username: userId, broadcasting, isMe: false };
}

function items(owner: string, count: number): QueueItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${owner}${i + 1}`,
    uri: `spotify:track:${owner}${i + 1}`,
    trackId: `${owner}${i + 1}`,
    addedBy: owner,
  }));
}

const alice = participant(1, "a", true);
const bob = participant(2, "b", true);
const carol = participant(3, "c", true);

const ids = (entries: { item: QueueItem }[]) => entries.map((e) => e.item.id);

describe("broadcasterOrder", () => {
  it("keeps only broadcasters, sorted by clientId ascending", () => {
    const listener = participant(2, "b", false);
    const order = broadcasterOrder([carol, listener, alice]);
    expect(order.map((p) => p.userId)).toEqual(["a", "c"]);
  });
});

describe("projectSessionQueue", () => {
  it("interleaves broadcasters one track per turn", () => {
    const entries = projectSessionQueue(
      [alice, bob],
      { a: items("a", 2), b: items("b", 2) },
      null,
    );
    expect(ids(entries)).toEqual(["a1", "b1", "a2", "b2"]);
    expect(entries.map((e) => e.ownerId)).toEqual(["a", "b", "a", "b"]);
  });

  it("skips a broadcaster that has run out and keeps going", () => {
    const entries = projectSessionQueue(
      [alice, bob, carol],
      { a: items("a", 3), b: items("b", 1), c: [] },
      null,
    );
    expect(ids(entries)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("starts with the broadcaster after the last owner", () => {
    const queues = { a: items("a", 1), b: items("b", 1), c: items("c", 1) };
    expect(ids(projectSessionQueue([alice, bob, carol], queues, "a"))).toEqual([
      "b1",
      "c1",
      "a1",
    ]);
    expect(ids(projectSessionQueue([alice, bob, carol], queues, "c"))).toEqual([
      "a1",
      "b1",
      "c1",
    ]);
  });

  it("starts at the front when the last owner no longer broadcasts", () => {
    const entries = projectSessionQueue(
      [alice, bob],
      { a: items("a", 1), b: items("b", 1) },
      "gone",
    );
    expect(ids(entries)).toEqual(["a1", "b1"]);
  });

  it("excludes queues belonging to non-broadcasters", () => {
    const entries = projectSessionQueue(
      [alice],
      { a: items("a", 2), b: items("b", 5) },
      null,
    );
    expect(ids(entries)).toEqual(["a1", "a2"]);
  });

  it("returns nothing when there are no broadcasters or no tracks", () => {
    expect(projectSessionQueue([], { a: items("a", 3) }, null)).toEqual([]);
    expect(projectSessionQueue([alice, bob], { a: [], b: [] }, null)).toEqual([]);
    expect(projectSessionQueue([alice], {}, null)).toEqual([]);
  });
});
