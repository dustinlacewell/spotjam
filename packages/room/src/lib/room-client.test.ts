import { describe, expect, it } from "vitest";
import {
  NULL_POINTER,
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
  reduce,
  registerPayload,
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

function viewOf(snap: RoomSnapshot): RoomView {
  return reduce(INITIAL_VIEW, { type: "room-state", snapshot: snap });
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
    expect(ops.move(ROOM, 2, 0)).toEqual({ type: "move", roomId: ROOM, fromIndex: 2, toIndex: 0 });
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

  it("carries the whole progress sample, not just a position", () => {
    // Listeners need all four fields: the item to scope the sample, the
    // duration to size the bar, and the sample time to extrapolate from.
    expect(
      ops.reportProgress(ROOM, {
        itemId: "i1",
        positionMs: 99,
        durationMs: 200_000,
        sampledAtEpochMs: EPOCH,
      }),
    ).toEqual({
      type: "report-progress",
      roomId: ROOM,
      itemId: "i1",
      positionMs: 99,
      durationMs: 200_000,
      sampledAtEpochMs: EPOCH,
    });
  });

  it("greets with hello and registers with a username", () => {
    expect(helloPayload()).toEqual({ type: "hello" });
    expect(registerPayload("alice")).toEqual({ type: "register", username: "alice" });
  });

  it("mints a fresh id per track and carries no owner", () => {
    const items = toQueueItems([
      { uri: "spotify:track:x", trackId: "x" },
      { uri: "spotify:track:x", trackId: "x" },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
    expect(items[0]).toEqual({
      id: items[0].id,
      uri: "spotify:track:x",
      trackId: "x",
    });
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
    const view = viewOf(snapshot({ myQueue: [{ id: "i1", uri: "u", trackId: "t" }] }));

    expect(view.status.synced).toBe(true);
    expect(myQueueOf(view)).toEqual([{ id: "i1", uri: "u", trackId: "t" }]);
  });

  it("keeps a typed error, with copy for the user", () => {
    const view = reduce(INITIAL_VIEW, {
      type: "error",
      code: "stale-envelope",
      message: "Envelope rejected: stale-timestamp.",
    });

    expect(view.lastError?.code).toBe("stale-envelope");
    expect(view.lastError?.humanMessage).toMatch(/clock/i);
  });

  it("clears a stale error once a snapshot arrives", () => {
    const errored = reduce(INITIAL_VIEW, {
      type: "error",
      code: "internal",
      message: "boom",
    });
    const recovered = reduce(errored, { type: "room-state", snapshot: snapshot() });

    expect(recovered.lastError).toBeNull();
  });

  it("leaves the view untouched for a registered event", () => {
    const event: ServerEvent = { type: "registered", pubkey: ME, username: "alice" };
    expect(reduce(INITIAL_VIEW, event)).toBe(INITIAL_VIEW);
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

  it("knows another person's queue is not in the snapshot", () => {
    const mine = [{ id: "i1", uri: "u", trackId: "t" }];
    const view = viewOf(snapshot({ myQueue: mine }));

    expect(queueOf(view, ME, ME)).toEqual(mine);
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
    const view = reduce(INITIAL_VIEW, playlistsEvent(THEM, [MORNING]));
    expect(peerPlaylistsOf(view, THEM)).toEqual([MORNING]);
    expect(peerPlaylistsOf(view, ME)).toEqual([]);
  });

  it("replaces one owner's set without touching another's", () => {
    const first = reduce(INITIAL_VIEW, playlistsEvent(THEM, [MORNING]));
    const second = reduce(first, playlistsEvent(ME, [EVENING]));
    const third = reduce(second, playlistsEvent(THEM, []));

    expect(peerPlaylistsOf(third, THEM)).toEqual([]);
    expect(peerPlaylistsOf(third, ME)).toEqual([EVENING]);
  });

  it("leaves the snapshot and the error alone", () => {
    const view = viewOf(snapshot());
    const next = reduce(view, playlistsEvent(THEM, [MORNING]));
    expect(next.snapshot).toBe(view.snapshot);
    expect(next.lastError).toBe(view.lastError);
  });

  it("drops a cached set when its owner is gone from the snapshot", () => {
    let view = viewOf(snapshot());
    view = reduce(view, playlistsEvent(THEM, [MORNING]));
    view = reduce(view, playlistsEvent(ME, [EVENING]));

    const alone = reduce(view, {
      type: "room-state",
      snapshot: snapshot({
        participants: [
          { pubkey: ME, username: "alice", broadcasting: true, playlistsRevision: 0 },
        ],
      }),
    });

    // A rejoiner starts the server's copy empty, so a kept copy would be stale.
    expect(peerPlaylistsOf(alone, THEM)).toEqual([]);
    expect(peerPlaylistsOf(alone, ME)).toEqual([EVENING]);
  });

  it("keeps the cache object identical when everyone is still present", () => {
    let view = viewOf(snapshot());
    view = reduce(view, playlistsEvent(THEM, [MORNING]));

    const next = reduce(view, { type: "room-state", snapshot: snapshot() });
    expect(next.peerPlaylists).toBe(view.peerPlaylists);
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
