import { NULL_POINTER, type QueueItem, type SharedPlaylist } from "@spotjam/protocol";
import { describe, expect, it } from "vitest";

import * as Room from "./room-state.ts";
import type { RoomState } from "./room-state.ts";
import { seededRng } from "./testing.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

const NOW = 1_700_000_000_000;

function track(id: string): QueueItem {
  return { id, uri: `spotify:track:${id}`, trackId: id };
}

function roomWith(...people: Array<[string, string]>): RoomState {
  let state = Room.emptyRoom("jam");
  for (const [pubkey, name] of people) state = Room.join(state, pubkey, name);
  return state;
}

function ids(state: RoomState, pubkey: string): string[] {
  return (state.members.get(pubkey)?.queue ?? []).map((item) => item.id);
}

describe("membership", () => {
  it("adds a participant with an empty queue", () => {
    const state = roomWith([ALICE, "alice"]);
    expect(state.members.get(ALICE)).toMatchObject({
      username: "alice",
      broadcasting: false,
      queue: [],
    });
  });

  it("does not duplicate a rejoining key, and refreshes the name", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.join(state, ALICE, "alice-renamed");

    expect(state.order).toEqual([ALICE]);
    expect(state.members.get(ALICE)?.username).toBe("alice-renamed");
  });

  it("reports a room as deserted once the last member leaves", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    expect(Room.isDeserted(state)).toBe(false);

    state = Room.leave(state, ALICE);
    state = Room.leave(state, BOB);
    expect(Room.isDeserted(state)).toBe(true);
  });

  it("leaves a queue behind with the departing member", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.leave(state, ALICE);

    expect(state.members.has(ALICE)).toBe(false);
  });

  it("ignores a leave from someone who was never there", () => {
    const state = roomWith([ALICE, "alice"]);
    expect(Room.leave(state, BOB)).toBe(state);
  });
});

describe("queue operations", () => {
  it("appends on enqueue", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);
    state = Room.enqueue(state, ALICE, [track("t3")]);

    expect(ids(state, ALICE)).toEqual(["t1", "t2", "t3"]);
  });

  it("drops an item the queue already holds", () => {
    // Two windows on one identity both restore the same stored queue.
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);

    expect(ids(state, ALICE)).toEqual(["t1", "t2"]);
  });

  it("keeps the fresh items out of a partly duplicate batch", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);

    expect(ids(state, ALICE)).toEqual(["t1", "t2"]);
  });

  it("drops a duplicate within one batch", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t1")]);

    expect(ids(state, ALICE)).toEqual(["t1"]);
  });

  it("drops a fresh item for a track the queue already holds, keeping the existing one", () => {
    const again: QueueItem = { id: "later", uri: "spotify:track:t1", trackId: "t1" };
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.enqueue(state, ALICE, [again, track("t2")]);

    expect(ids(state, ALICE)).toEqual(["t1", "t2"]);
  });

  it("never mutates the input state", () => {
    const before = Room.enqueue(roomWith([ALICE, "alice"]), ALICE, [track("t1")]);
    const after = Room.enqueue(before, ALICE, [track("t2")]);

    expect(ids(before, ALICE)).toEqual(["t1"]);
    expect(ids(after, ALICE)).toEqual(["t1", "t2"]);
  });

  it("removes by item id", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);
    state = Room.remove(state, ALICE, "t1");

    expect(ids(state, ALICE)).toEqual(["t2"]);
  });

  it("moves within the queue", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2"), track("t3")]);
    state = Room.move(state, ALICE, 0, 2);

    expect(ids(state, ALICE)).toEqual(["t2", "t3", "t1"]);
  });

  it("ignores an out-of-range move", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);

    expect(ids(Room.move(state, ALICE, 0, 9), ALICE)).toEqual(["t1", "t2"]);
    expect(ids(Room.move(state, ALICE, -1, 1), ALICE)).toEqual(["t1", "t2"]);
  });

  it("sends an item to the top", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2"), track("t3")]);
    state = Room.sendToTop(state, ALICE, "t3");

    expect(ids(state, ALICE)).toEqual(["t3", "t1", "t2"]);
  });

  it("leaves the queue alone when send-to-top names nothing", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);

    expect(ids(Room.sendToTop(state, ALICE, "nope"), ALICE)).toEqual(["t1"]);
  });

  it("shuffles deterministically under a seeded rng", () => {
    let state = roomWith([ALICE, "alice"]);
    const items = ["t1", "t2", "t3", "t4", "t5"].map(track);
    state = Room.enqueue(state, ALICE, items);

    const once = Room.shuffle(state, ALICE, seededRng(42));
    const twice = Room.shuffle(state, ALICE, seededRng(42));

    expect(ids(once, ALICE)).toEqual(ids(twice, ALICE));
    expect([...ids(once, ALICE)].sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("clears a queue", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);

    expect(ids(Room.clearQueue(state, ALICE), ALICE)).toEqual([]);
  });

  it("ignores queue ops from a non-member", () => {
    const state = roomWith([ALICE, "alice"]);
    expect(Room.enqueue(state, BOB, [track("t1")])).toBe(state);
  });

  it("touches only the acting member's queue", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.enqueue(state, BOB, [track("b1")]);
    state = Room.clearQueue(state, ALICE);

    expect(ids(state, ALICE)).toEqual([]);
    expect(ids(state, BOB)).toEqual(["b1"]);
  });
});

describe("advance", () => {
  it("clears the pointer when nobody is broadcasting", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);

    expect(Room.advance(state, NOW).pointer).toEqual(NULL_POINTER);
  });

  it("pops the head of the only broadcaster's queue", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);
    state = Room.advance(state, NOW);

    expect(state.pointer).toMatchObject({
      itemId: "t1",
      ownerPubkey: ALICE,
      uri: "spotify:track:t1",
      startedAtEpochMs: NOW,
      isPaused: false,
    });
    expect(ids(state, ALICE)).toEqual(["t2"]);
  });

  it("alternates between broadcasters round-robin", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.setBroadcasting(state, BOB, true);
    state = Room.enqueue(state, ALICE, [track("a1"), track("a2")]);
    state = Room.enqueue(state, BOB, [track("b1"), track("b2")]);

    const played: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      state = Room.advance(state, NOW + i);
      played.push(state.pointer.itemId);
    }

    expect(played).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("skips a broadcaster who has run dry", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.setBroadcasting(state, BOB, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.enqueue(state, BOB, [track("b1"), track("b2")]);

    const played: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      state = Room.advance(state, NOW + i);
      played.push(state.pointer.itemId);
    }

    expect(played).toEqual(["a1", "b1", "b2"]);
  });

  it("clears the pointer once every queue is exhausted", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);

    state = Room.advance(state, NOW);
    expect(state.pointer.itemId).toBe("t1");

    state = Room.advance(state, NOW + 1);
    expect(state.pointer).toEqual(NULL_POINTER);
  });

  it("gives one identity a single turn even with two connections", () => {
    // Two sockets on one key must not double Alice's share of the rotation.
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.join(state, ALICE, "alice");
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.setBroadcasting(state, BOB, true);
    state = Room.enqueue(state, ALICE, [track("a1"), track("a2")]);
    state = Room.enqueue(state, BOB, [track("b1"), track("b2")]);

    const played: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      state = Room.advance(state, NOW + i);
      played.push(state.pointer.itemId);
    }

    expect(played).toEqual(["a1", "b1", "a2", "b2"]);
  });
});

describe("settleStart", () => {
  it("starts playback when a broadcaster has tracks and nothing is playing", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);

    state = Room.settleStart(state, NOW);
    expect(state.pointer).toMatchObject({
      itemId: "t1",
      ownerPubkey: ALICE,
      startedAtEpochMs: NOW,
    });
    expect(ids(state, ALICE)).toEqual(["t2"]);
  });

  it("leaves a pointer that already names a track", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1"), track("t2")]);
    state = Room.advance(state, NOW);

    expect(Room.settleStart(state, NOW + 5_000)).toBe(state);
  });

  it("does nothing when the member with tracks is not broadcasting", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.enqueue(state, ALICE, [track("t1")]);

    expect(Room.settleStart(state, NOW)).toBe(state);
  });

  it("does nothing when the broadcaster's queue is empty", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);

    expect(Room.settleStart(state, NOW)).toBe(state);
  });
});

describe("pointer clearing", () => {
  it("clears when the last broadcaster stops broadcasting", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.advance(state, NOW);

    state = Room.setBroadcasting(state, ALICE, false);
    expect(state.pointer).toEqual(NULL_POINTER);
  });

  it("clears when the last broadcaster leaves", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.advance(state, NOW);

    state = Room.leave(state, ALICE);
    expect(state.pointer).toEqual(NULL_POINTER);
  });

  it("keeps playing while another broadcaster remains", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.setBroadcasting(state, BOB, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.advance(state, NOW);

    state = Room.leave(state, BOB);
    expect(state.pointer.itemId).toBe("a1");
  });
});

describe("transport", () => {
  it("freezes the offset on pause and rebases on resume", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.advance(state, NOW);

    state = Room.setPaused(state, true, NOW + 5_000);
    expect(state.pointer).toMatchObject({ isPaused: true, pausedAtOffsetMs: 5_000 });

    state = Room.setPaused(state, false, NOW + 20_000);
    expect(state.pointer).toMatchObject({
      isPaused: false,
      startedAtEpochMs: NOW + 15_000,
      pausedAtOffsetMs: 0,
    });
  });

  it("does nothing with no track playing", () => {
    const state = roomWith([ALICE, "alice"]);
    expect(Room.setPaused(state, true, NOW)).toBe(state);
    expect(Room.seek(state, 1_000, NOW)).toBe(state);
  });

  it("seeks while playing by moving the start time", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.advance(state, NOW);

    state = Room.seek(state, 30_000, NOW + 1_000);
    expect(state.pointer.startedAtEpochMs).toBe(NOW + 1_000 - 30_000);
  });

  it("seeks while paused by moving the frozen offset", () => {
    let state = roomWith([ALICE, "alice"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("t1")]);
    state = Room.advance(state, NOW);
    state = Room.setPaused(state, true, NOW + 1_000);

    state = Room.seek(state, 42_000, NOW + 2_000);
    expect(state.pointer).toMatchObject({ isPaused: true, pausedAtOffsetMs: 42_000 });
  });
});

describe("progress", () => {
  /** A room where Alice is broadcasting and her first track is playing. */
  function playing(): RoomState {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1"), track("a2")]);
    return Room.advance(state, NOW);
  }

  function sample(itemId: string, positionMs: number) {
    return { itemId, positionMs, durationMs: 200_000, sampledAtEpochMs: NOW };
  }

  it("keeps a sample for the track the pointer names", () => {
    const state = Room.reportProgress(playing(), ALICE, sample("a1", 12_000));
    expect(state.members.get(ALICE)?.progress).toEqual(sample("a1", 12_000));
  });

  it("ignores a sample for any other track", () => {
    // A sample that arrives just after an advance describes the old track;
    // keeping it would draw a bar for music nobody is playing.
    const state = Room.reportProgress(playing(), ALICE, sample("a2", 500));
    expect(state.members.get(ALICE)?.progress).toBeNull();
  });

  it("drops every sample when the pointer moves on", () => {
    let state = Room.reportProgress(playing(), ALICE, sample("a1", 12_000));
    state = Room.advance(state, NOW + 1000);

    expect(state.pointer.itemId).toBe("a2");
    expect(state.members.get(ALICE)?.progress).toBeNull();
  });

  it("drops samples when the last broadcaster stops", () => {
    let state = Room.reportProgress(playing(), ALICE, sample("a1", 12_000));
    state = Room.setBroadcasting(state, ALICE, false);

    expect(state.pointer).toEqual(NULL_POINTER);
    expect(state.members.get(ALICE)?.progress).toBeNull();
  });

  it("projects the sample of whoever is feeding the current track", () => {
    const state = Room.reportProgress(playing(), ALICE, sample("a1", 12_000));

    // Bob is a listener: he sees Alice's position, which is what the room hears.
    expect(Room.projectSnapshot(state, BOB, NOW).progress).toEqual(
      sample("a1", 12_000),
    );
  });

  it("ignores a sample from someone who is not feeding the track", () => {
    let state = playing();
    state = Room.reportProgress(state, BOB, sample("a1", 999));

    expect(Room.projectSnapshot(state, ALICE, NOW).progress).toBeNull();
  });

  it("projects no sample before anyone has reported one", () => {
    expect(Room.projectSnapshot(playing(), ALICE, NOW).progress).toBeNull();
  });
});

describe("public playlists", () => {
  const mix: SharedPlaylist = {
    id: "p1",
    name: "Morning",
    tracks: [{ uri: "spotify:track:a1", trackId: "a1" }],
  };

  it("reads back what a member set", () => {
    const state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, [mix]);
    expect(Room.publicPlaylistsOf(state, ALICE)).toEqual([mix]);
  });

  it("starts a joiner with none", () => {
    expect(Room.publicPlaylistsOf(roomWith([ALICE, "alice"]), ALICE)).toEqual([]);
  });

  it("copies the array rather than aliasing the caller's", () => {
    const given: SharedPlaylist[] = [mix];
    const state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, given);
    given.length = 0;

    expect(Room.publicPlaylistsOf(state, ALICE)).toEqual([mix]);
  });

  it("scopes a set to its own member", () => {
    const state = Room.setPublicPlaylists(
      roomWith([ALICE, "alice"], [BOB, "bob"]),
      ALICE,
      [mix],
    );
    expect(Room.publicPlaylistsOf(state, BOB)).toEqual([]);
  });

  it("ignores a set from an unknown member", () => {
    const state = roomWith([ALICE, "alice"]);
    expect(Room.setPublicPlaylists(state, CAROL, [mix])).toBe(state);
  });

  it("offers nothing for an unknown member rather than throwing", () => {
    expect(Room.publicPlaylistsOf(roomWith([ALICE, "alice"]), CAROL)).toEqual([]);
  });

  it("drops a member's playlists when they leave", () => {
    let state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, [mix]);
    state = Room.leave(state, ALICE);

    expect(Room.publicPlaylistsOf(state, ALICE)).toEqual([]);
  });

  /** The revision a snapshot reports for one member. */
  function revisionOf(state: RoomState, pubkey: string): number | undefined {
    return Room.projectSnapshot(state, ALICE, NOW).participants.find(
      (p) => p.pubkey === pubkey,
    )?.playlistsRevision;
  }

  it("starts a joiner's revision at 0", () => {
    expect(revisionOf(roomWith([ALICE, "alice"]), ALICE)).toBe(0);
  });

  it("bumps the revision on every set, even an identical one", () => {
    let state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, [mix]);
    expect(revisionOf(state, ALICE)).toBe(1);

    state = Room.setPublicPlaylists(state, ALICE, [mix]);
    expect(revisionOf(state, ALICE)).toBe(2);
  });

  it("leaves other members' revisions alone", () => {
    const state = Room.setPublicPlaylists(
      roomWith([ALICE, "alice"], [BOB, "bob"]),
      ALICE,
      [mix],
    );
    expect(revisionOf(state, BOB)).toBe(0);
  });

  it("resets the revision when a member rejoins", () => {
    let state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, [mix]);
    state = Room.leave(state, ALICE);
    state = Room.join(state, ALICE, "alice");

    expect(revisionOf(state, ALICE)).toBe(0);
  });

  it("keeps playlists out of the snapshot", () => {
    const state = Room.setPublicPlaylists(roomWith([ALICE, "alice"]), ALICE, [mix]);
    const snapshot = Room.projectSnapshot(state, ALICE, NOW);

    expect(Object.keys(snapshot).sort()).toEqual([
      "myQueue",
      "participants",
      "pointer",
      "progress",
      "roomId",
      "serverTime",
      "sessionQueue",
    ]);
  });
});

describe("projectSnapshot", () => {
  it("gives each recipient their own queue", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.enqueue(state, BOB, [track("b1")]);

    expect(Room.projectSnapshot(state, ALICE, NOW).myQueue.map((i) => i.id)).toEqual(["a1"]);
    expect(Room.projectSnapshot(state, BOB, NOW).myQueue.map((i) => i.id)).toEqual(["b1"]);
  });

  it("interleaves the session queue round-robin across broadcasters", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.setBroadcasting(state, BOB, true);
    state = Room.enqueue(state, ALICE, [track("a1"), track("a2")]);
    state = Room.enqueue(state, BOB, [track("b1"), track("b2")]);

    const snapshot = Room.projectSnapshot(state, ALICE, NOW);
    expect(snapshot.sessionQueue.map((entry) => entry.item.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
    expect(snapshot.sessionQueue[0]).toMatchObject({
      ownerPubkey: ALICE,
      ownerName: "alice",
    });
  });

  it("omits non-broadcasters from the session queue", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"]);
    state = Room.setBroadcasting(state, ALICE, true);
    state = Room.enqueue(state, ALICE, [track("a1")]);
    state = Room.enqueue(state, BOB, [track("b1")]);

    const snapshot = Room.projectSnapshot(state, BOB, NOW);
    expect(snapshot.sessionQueue.map((entry) => entry.item.id)).toEqual(["a1"]);
    // Bob still sees his own queue even though he is not broadcasting.
    expect(snapshot.myQueue.map((item) => item.id)).toEqual(["b1"]);
  });

  it("lists every participant with their broadcasting flag", () => {
    let state = roomWith([ALICE, "alice"], [BOB, "bob"], [CAROL, "carol"]);
    state = Room.setBroadcasting(state, BOB, true);

    expect(Room.projectSnapshot(state, ALICE, NOW).participants).toEqual([
      { pubkey: ALICE, username: "alice", broadcasting: false, playlistsRevision: 0 },
      { pubkey: BOB, username: "bob", broadcasting: true, playlistsRevision: 0 },
      { pubkey: CAROL, username: "carol", broadcasting: false, playlistsRevision: 0 },
    ]);
  });

  it("stamps the server time", () => {
    expect(Room.projectSnapshot(roomWith([ALICE, "alice"]), ALICE, NOW).serverTime).toBe(NOW);
  });

  it("gives a stranger an empty myQueue rather than throwing", () => {
    const snapshot = Room.projectSnapshot(roomWith([ALICE, "alice"]), CAROL, NOW);
    expect(snapshot.myQueue).toEqual([]);
  });
});
