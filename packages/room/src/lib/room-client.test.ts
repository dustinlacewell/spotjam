import { describe, expect, it } from "vitest";
import {
  NULL_POINTER,
  type QueueItem,
  type RoomSnapshot,
  type ServerEvent,
  type SharedPlaylist,
} from "@spotjam/protocol";
import {
  INITIAL_VIEW,
  backoffMs,
  describeError,
  helloPayload,
  isBroadcasting,
  myQueueOf,
  ops,
  parseServerEvent,
  participantsOf,
  peerPlaylistsOf,
  pointerOf,
  queueOf,
  queueToRestore,
  reduce,
  registerPayload,
  serverNowOf,
  sessionQueueOf,
  toQueueItems,
  usernameOf,
  type RoomView,
} from "./room-client";

const ROOM = "jam";
const ME = "aa".repeat(32);
const THEM = "bb".repeat(32);
const EPOCH = 1_700_000_000_000;

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: ROOM,
    participants: [
      { pubkey: ME, username: "alice", broadcasting: true, playlistsRevision: 0 },
      { pubkey: THEM, username: "bob", broadcasting: false, playlistsRevision: 0 },
    ],
    sessionQueue: [],
    myQueue: [],
    pointer: NULL_POINTER,
    serverTime: 1_700_000_000_000,
    ...overrides,
  };
}

/** A queue item. Every one carries a length; nothing here cares which. */
function item(id: string): QueueItem {
  return { id, uri: `u${id}`, trackId: id, durationMs: 200_000 };
}

function viewOf(snap: RoomSnapshot): RoomView {
  return reduce(INITIAL_VIEW, { type: "room-state", snapshot: snap }, EPOCH);
}

describe("outgoing payloads", () => {
  it("builds an op for every mutating gesture", () => {
    expect(ops.joinRoom(ROOM)).toEqual({ type: "join-room", roomId: ROOM });
    expect(ops.setBroadcasting(ROOM, true)).toEqual({
      type: "set-broadcasting",
      roomId: ROOM,
      broadcasting: true,
    });
    expect(ops.remove(ROOM, "i1")).toEqual({ type: "remove", roomId: ROOM, itemId: "i1" });
    expect(ops.moveMany(ROOM, ["i1", "i2"], "i3")).toEqual({
      type: "move-many",
      roomId: ROOM,
      itemIds: ["i1", "i2"],
      beforeItemId: "i3",
    });
    expect(ops.sendToTop(ROOM, "i1")).toEqual({
      type: "send-to-top",
      roomId: ROOM,
      itemId: "i1",
    });
    expect(ops.shuffle(ROOM)).toEqual({ type: "shuffle", roomId: ROOM });
    expect(ops.clearQueue(ROOM)).toEqual({ type: "clear-queue", roomId: ROOM });
    expect(ops.setPaused(ROOM, true)).toEqual({ type: "set-paused", roomId: ROOM, paused: true });
    expect(ops.skip(ROOM)).toEqual({ type: "skip", roomId: ROOM });
  });

  it("rounds and floors positions, because canonical JSON rejects fractions", () => {
    expect(ops.seek(ROOM, 1234.7)).toEqual({ type: "seek", roomId: ROOM, positionMs: 1235 });
    expect(ops.seek(ROOM, -50)).toEqual({ type: "seek", roomId: ROOM, positionMs: 0 });
  });

  it("greets with hello and registers with a username", () => {
    expect(helloPayload()).toEqual({ type: "hello" });
    expect(registerPayload("alice")).toEqual({ type: "register", username: "alice" });
  });

  it("mints a fresh id per track and carries no owner", () => {
    const items = toQueueItems([
      { uri: "spotify:track:x", trackId: "x", durationMs: 200_000 },
      { uri: "spotify:track:x", trackId: "x", durationMs: 200_000 },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
    expect(items[0]).toEqual({
      id: items[0].id,
      uri: "spotify:track:x",
      trackId: "x",
      durationMs: 200_000,
    });
  });

  /**
   * The server advances the pointer on durations alone, so a zero-length item
   * would start and end in the same tick and take the rest of the queue with
   * it. Dropping it is the safe direction.
   */
  it("drops a track whose length is unknown rather than queueing it at zero", () => {
    const items = toQueueItems([
      { uri: "spotify:track:x", trackId: "x", durationMs: 0 },
      { uri: "spotify:track:y", trackId: "y", durationMs: -1 },
      { uri: "spotify:track:z", trackId: "z", durationMs: 1000 },
    ]);

    expect(items.map((item) => item.trackId)).toEqual(["z"]);
  });
});

describe("parseServerEvent", () => {
  it("reads a well-formed event", () => {
    const event: ServerEvent = { type: "registered", pubkey: ME, username: "alice" };
    expect(parseServerEvent(JSON.stringify(event))).toEqual(event);
  });

  it("rejects junk, non-JSON, and unknown types", () => {
    expect(parseServerEvent("not json")).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: "nonsense" }))).toBeNull();
    expect(parseServerEvent(JSON.stringify(null))).toBeNull();
  });
});

describe("reduce", () => {
  it("stores a snapshot and marks the room synced", () => {
    const view = viewOf(snapshot({ myQueue: [item("i1")] }));

    expect(view.status.synced).toBe(true);
    expect(myQueueOf(view)).toEqual([item("i1")]);
  });

  it("folds the snapshot's server time into the clock offset", () => {
    // The server is 5s ahead of this machine.
    const view = reduce(
      INITIAL_VIEW,
      { type: "room-state", snapshot: snapshot({ serverTime: EPOCH + 5_000 }) },
      EPOCH,
    );

    expect(view.clockOffsetMs).toBe(5_000);
    expect(serverNowOf(view, EPOCH)).toBe(EPOCH + 5_000);
  });

  it("blends a later server time rather than swapping to it", () => {
    // One late frame must not yank the bar; the offset moves a step at a time.
    const first = reduce(
      INITIAL_VIEW,
      { type: "room-state", snapshot: snapshot({ serverTime: EPOCH }) },
      EPOCH,
    );
    const second = reduce(
      first,
      { type: "room-state", snapshot: snapshot({ serverTime: EPOCH + 1_000 }) },
      EPOCH,
    );

    expect(first.clockOffsetMs).toBe(0);
    expect(second.clockOffsetMs).toBeGreaterThan(0);
    expect(second.clockOffsetMs).toBeLessThan(1_000);
  });

  it("reads local time as server time before any snapshot has landed", () => {
    expect(INITIAL_VIEW.clockOffsetMs).toBeNull();
    expect(serverNowOf(INITIAL_VIEW, EPOCH)).toBe(EPOCH);
  });

  it("keeps a typed error, with copy for the user", () => {
    const view = reduce(
      INITIAL_VIEW,
      { type: "error", code: "stale-envelope", message: "Envelope rejected: stale-timestamp." },
      EPOCH,
    );

    expect(view.lastError?.code).toBe("stale-envelope");
    expect(view.lastError?.humanMessage).toMatch(/clock/i);
  });

  it("clears a stale error once a snapshot arrives", () => {
    const errored = reduce(
      INITIAL_VIEW,
      { type: "error", code: "internal", message: "boom" },
      EPOCH,
    );
    const recovered = reduce(errored, { type: "room-state", snapshot: snapshot() }, EPOCH);

    expect(recovered.lastError).toBeNull();
  });

  it("leaves the view untouched for a registered event", () => {
    const event: ServerEvent = { type: "registered", pubkey: ME, username: "alice" };
    expect(reduce(INITIAL_VIEW, event, EPOCH)).toBe(INITIAL_VIEW);
  });

  it("describes every error code without throwing", () => {
    const codes = [
      "bad-signature",
      "stale-envelope",
      "replay",
      "unknown-identity",
      "username-taken",
      "invalid-username",
      "not-in-room",
      "malformed",
      "internal",
    ] as const;

    for (const code of codes) {
      expect(describeError(code, "x").humanMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("reading the view", () => {
  it("is empty before the first snapshot", () => {
    expect(participantsOf(INITIAL_VIEW)).toEqual([]);
    expect(sessionQueueOf(INITIAL_VIEW)).toEqual([]);
    expect(myQueueOf(INITIAL_VIEW)).toEqual([]);
    expect(pointerOf(INITIAL_VIEW)).toEqual(NULL_POINTER);
  });

  it("serves the session queue exactly as the server ordered it", () => {
    const entries = [
      { item: { id: "a1", uri: "ua1", trackId: "a1" }, ownerPubkey: ME, ownerName: "alice" },
      { item: { id: "b1", uri: "ub1", trackId: "b1" }, ownerPubkey: THEM, ownerName: "bob" },
    ];
    const view = viewOf(snapshot({ sessionQueue: entries }));

    // No client-side rotation: the order is the server's, untouched.
    expect(sessionQueueOf(view)).toEqual(entries);
  });

  it("reads broadcasting off my own participant record", () => {
    const view = viewOf(snapshot());
    expect(isBroadcasting(view, ME)).toBe(true);
    expect(isBroadcasting(view, THEM)).toBe(false);
  });

  it("reads my own queue from the snapshot", () => {
    const mine = [item("i1")];
    const view = viewOf(snapshot({ myQueue: mine }));

    expect(queueOf(view, ME, ME)).toEqual(mine);
  });

  it("recovers a peer's queue in order from the interleaved session queue", () => {
    const b1 = item("b1");
    const b2 = item("b2");
    const view = viewOf(
      snapshot({
        sessionQueue: [
          { item: item("a1"), ownerPubkey: ME, ownerName: "alice" },
          { item: b1, ownerPubkey: THEM, ownerName: "bob" },
          { item: item("a2"), ownerPubkey: ME, ownerName: "alice" },
          { item: b2, ownerPubkey: THEM, ownerName: "bob" },
        ],
      }),
    );

    expect(queueOf(view, THEM, ME)).toEqual([b1, b2]);
  });

  it("shows a peer with no session entries as empty", () => {
    const view = viewOf(
      snapshot({
        sessionQueue: [{ item: item("a1"), ownerPubkey: ME, ownerName: "alice" }],
      }),
    );

    expect(queueOf(view, THEM, ME)).toEqual([]);
  });

  it("maps a pubkey to a display name, falling back for strangers", () => {
    const view = viewOf(snapshot());
    expect(usernameOf(view, ME)).toBe("alice");
    expect(usernameOf(view, "cc".repeat(32))).toBe("someone");
    expect(usernameOf(view, null)).toBe("someone");
  });
});

describe("shared playlists", () => {
  const MORNING: SharedPlaylist = {
    id: "p1",
    name: "Morning",
    tracks: [{ uri: "spotify:track:aaaa1111", trackId: "aaaa1111" }],
  };
  const EVENING: SharedPlaylist = { id: "p2", name: "Evening", tracks: [] };

  function playlistsEvent(owner: string, playlists: SharedPlaylist[]): ServerEvent {
    return { type: "playlists", roomId: ROOM, ownerPubkey: owner, playlists };
  }

  it("builds a full-replace set-public-playlists op", () => {
    expect(ops.setPublicPlaylists(ROOM, [MORNING])).toEqual({
      type: "set-public-playlists",
      roomId: ROOM,
      playlists: [MORNING],
    });
  });

  it("builds a view-playlists op naming the owner", () => {
    expect(ops.viewPlaylists(ROOM, THEM)).toEqual({
      type: "view-playlists",
      roomId: ROOM,
      ownerPubkey: THEM,
    });
  });

  it("accepts a playlists frame as a server event", () => {
    const raw = JSON.stringify(playlistsEvent(THEM, [MORNING]));
    expect(parseServerEvent(raw)).toEqual(playlistsEvent(THEM, [MORNING]));
  });

  it("starts with nobody's playlists known", () => {
    expect(INITIAL_VIEW.peerPlaylists).toEqual({});
    expect(peerPlaylistsOf(INITIAL_VIEW, THEM)).toEqual([]);
  });

  it("folds a playlists event in under its owner", () => {
    const view = reduce(INITIAL_VIEW, playlistsEvent(THEM, [MORNING]), EPOCH);
    expect(peerPlaylistsOf(view, THEM)).toEqual([MORNING]);
    expect(peerPlaylistsOf(view, ME)).toEqual([]);
  });

  it("replaces one owner's set without touching another's", () => {
    const first = reduce(INITIAL_VIEW, playlistsEvent(THEM, [MORNING]), EPOCH);
    const second = reduce(first, playlistsEvent(ME, [EVENING]), EPOCH);
    const third = reduce(second, playlistsEvent(THEM, []), EPOCH);

    expect(peerPlaylistsOf(third, THEM)).toEqual([]);
    expect(peerPlaylistsOf(third, ME)).toEqual([EVENING]);
  });

  it("leaves the snapshot and the error alone", () => {
    const view = viewOf(snapshot());
    const next = reduce(view, playlistsEvent(THEM, [MORNING]), EPOCH);
    expect(next.snapshot).toBe(view.snapshot);
    expect(next.lastError).toBe(view.lastError);
  });

  it("drops a cached set when its owner is gone from the snapshot", () => {
    let view = viewOf(snapshot());
    view = reduce(view, playlistsEvent(THEM, [MORNING]), EPOCH);
    view = reduce(view, playlistsEvent(ME, [EVENING]), EPOCH);

    const alone = reduce(
      view,
      {
        type: "room-state",
        snapshot: snapshot({
          participants: [
            { pubkey: ME, username: "alice", broadcasting: true, playlistsRevision: 0 },
          ],
        }),
      },
      EPOCH,
    );

    // A rejoiner starts the server's copy empty, so a kept copy would be stale.
    expect(peerPlaylistsOf(alone, THEM)).toEqual([]);
    expect(peerPlaylistsOf(alone, ME)).toEqual([EVENING]);
  });

  it("keeps the cache object identical when everyone is still present", () => {
    let view = viewOf(snapshot());
    view = reduce(view, playlistsEvent(THEM, [MORNING]), EPOCH);

    const next = reduce(view, { type: "room-state", snapshot: snapshot() }, EPOCH);
    expect(next.peerPlaylists).toBe(view.peerPlaylists);
  });
});

describe("queueToRestore", () => {
  const stored = [
    { id: "i1", uri: "spotify:track:x", trackId: "x" },
    { id: "i2", uri: "spotify:track:y", trackId: "y" },
  ];

  it("hands the stored queue back when the server has none", () => {
    expect(queueToRestore(stored, snapshot())).toEqual(stored);
  });

  it("restores nothing when the server still holds a queue", () => {
    expect(queueToRestore(stored, snapshot({ myQueue: [stored[0]] }))).toEqual([]);
  });

  it("restores nothing when there is nothing stored", () => {
    expect(queueToRestore([], snapshot())).toEqual([]);
  });
});

describe("backoffMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
  });

  it("caps so a long outage does not stall a rejoin forever", () => {
    expect(backoffMs(20)).toBe(15_000);
  });
});
