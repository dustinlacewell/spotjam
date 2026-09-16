// Session — the dispatch layer between a socket and the pure core.
//
// It owns the sequence every message runs: verify the envelope, spend the
// nonce, decide whether the payload is auth or an op, apply it, and broadcast
// what changed. It talks to transports through `Sendable`, so the whole layer
// runs in a test with no network.

import {
  open,
  isOp,
  isQuery,
  type AuthPayload,
  type Envelope,
  type ErrorEvent,
  type Op,
  type Query,
  type RoomSummary,
  type ServerEvent,
} from "@spotjam/protocol";

import {
  connectionsInRoom,
  connectionsWatchingList,
  connectionsWatchingRoom,
  type Connection,
} from "./connections.ts";
import { handleOp, type ErrorCode } from "./handle-op.ts";
import type { IdentityStore } from "./identity-store.ts";
import type { Clock, Rng } from "./ports.ts";
import type { ReplayGuard } from "./replay-guard.ts";
import { RoomClock, nodeTimers, type Timers } from "./room-clock.ts";
import * as Room from "./room-state.ts";
import { sameSummary, summarize } from "./room-summary.ts";
import type { RoomRegistry } from "./rooms.ts";

export interface SessionDeps {
  rooms: RoomRegistry;
  identities: IdentityStore;
  replay: ReplayGuard;
  clock: Clock;
  rng: Rng;
  /** How the room clock schedules a track end. Node's timers unless a test says otherwise. */
  timers?: Timers;
}

/**
 * Everything the server does with one incoming frame.
 *
 * Never throws: a bad frame is answered with a typed error event, because one
 * malformed message must not take down a room full of people.
 */
export class Session {
  readonly #deps: SessionDeps;
  readonly #connections = new Set<Connection>();
  /**
   * The last summary published for each room.
   *
   * The gate for list watchers: a room commits on every seek, pause and
   * reorder, and none of those change what a browser shows. Without this,
   * watching the list would cost a push for each one, for every live room.
   */
  readonly #lastSummary = new Map<string, RoomSummary>();
  /** Ends tracks on the server's clock, since no client reports a track end. */
  readonly #roomClock: RoomClock;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#roomClock = new RoomClock({
      rooms: deps.rooms,
      clock: deps.clock,
      timers: deps.timers ?? nodeTimers,
      publish: (roomId) => this.#publish(roomId),
    });
  }

  /** Drop every pending track-end timer. For shutdown. */
  stop(): void {
    this.#roomClock.cancelAll();
  }

  add(connection: Connection): void {
    this.#connections.add(connection);
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Handle one raw frame from a socket. */
  receive(connection: Connection, raw: string): void {
    const envelope = this.#verify(connection, raw);
    if (envelope === null) return;

    const { payload, pubkey } = envelope;

    if (isAuthPayload(payload)) {
      this.#authenticate(connection, pubkey, payload);
      return;
    }

    if (isOp(payload)) {
      this.#applyOp(connection, pubkey, payload);
      return;
    }

    if (isQuery(payload)) {
      this.#handleQuery(connection, pubkey, payload);
      return;
    }

    send(connection, error("malformed", "Payload is neither an auth message, an op, nor a query."));
  }

  /** Drop a socket: leave its room, then tell whoever is left. */
  close(connection: Connection): void {
    this.#connections.delete(connection);
    const { roomId, pubkey } = connection;
    connection.roomId = null;
    connection.watchingList = false;
    connection.watchingRoomId = null;
    if (roomId === null || pubkey === null) return;

    // Another socket may hold the same key; the identity stays in the room
    // until its last connection goes.
    if (this.#stillPresent(pubkey, roomId)) {
      this.#publish(roomId);
      return;
    }

    const { rooms } = this.#deps;
    rooms.commit(Room.leave(rooms.get(roomId), pubkey));
    this.#publish(roomId);
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** Parse, verify the signature, and spend the nonce. Null when refused. */
  #verify(connection: Connection, raw: string): Envelope | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(connection, error("malformed", "Frame is not valid JSON."));
      return null;
    }

    const now = this.#deps.clock.now();
    const opened = open(parsed, now);
    if (!opened.ok) {
      send(connection, error(failureCode(opened.reason), `Envelope rejected: ${opened.reason}.`));
      return null;
    }

    if (!this.#deps.replay.admit(opened.nonce, now)) {
      send(connection, error("replay", "Envelope nonce was already used."));
      return null;
    }

    return parsed as Envelope;
  }

  /** Bind a username to the key, or greet a key that already has one. */
  #authenticate(connection: Connection, pubkey: string, payload: AuthPayload): void {
    const { identities, clock } = this.#deps;

    if (payload.type === "register") {
      if (typeof payload.username !== "string") {
        send(connection, error("invalid-username", "Username must be a string."));
        return;
      }
      const result = identities.register(pubkey, payload.username, clock.now());
      if (!result.ok) {
        send(connection, error(result.reason, `Registration refused: ${result.reason}.`));
        return;
      }
      this.#adopt(connection, pubkey, result.record.username);
      return;
    }

    const record = identities.lookupByPubkey(pubkey);
    if (record === null) {
      send(connection, error("unknown-identity", "This key has not registered a username."));
      return;
    }
    this.#adopt(connection, pubkey, record.username);
  }

  #adopt(connection: Connection, pubkey: string, username: string): void {
    connection.pubkey = pubkey;
    connection.username = username;
    send(connection, { type: "registered", pubkey, username });
  }

  /** Route an op: room moves are the shell's, the rest go to the core. */
  #applyOp(connection: Connection, pubkey: string, op: Op): void {
    if (connection.pubkey === null || connection.username === null) {
      send(connection, error("unknown-identity", "Authenticate before sending ops."));
      return;
    }
    if (connection.pubkey !== pubkey) {
      // The socket signed with a different key than it authenticated with.
      send(connection, error("unknown-identity", "Envelope key does not match this session."));
      return;
    }
    if (typeof op.roomId !== "string" || op.roomId.length === 0) {
      send(connection, error("malformed", "Op is missing a room id."));
      return;
    }

    if (op.type === "join-room") {
      this.#joinRoom(connection, pubkey, connection.username, op.roomId);
      return;
    }
    if (op.type === "leave-room") {
      this.#leaveRoom(connection, pubkey, op.roomId);
      return;
    }

    if (connection.roomId !== op.roomId) {
      send(connection, error("not-in-room", "You are not in that room."));
      return;
    }

    if (op.type === "view-playlists") {
      this.#viewPlaylists(connection, op.roomId, op.ownerPubkey);
      return;
    }

    const { rooms, clock, rng } = this.#deps;
    const outcome = handleOp(rooms.get(op.roomId), pubkey, op, { now: clock.now(), rng });
    rooms.commit(outcome.state);

    if (outcome.error !== undefined) {
      // A refused op still settled the room on the way in, so the timer may be
      // describing a track that already ended. Re-point it; tell nobody.
      this.#roomClock.arm(op.roomId);
      send(connection, error(outcome.error, `Op ${op.type} refused: ${outcome.error}.`));
      return;
    }
    this.#publish(op.roomId);
  }

  /**
   * Answer one member's playlists to the asker alone.
   *
   * A read, so nothing is published: the room did not move, and the other
   * members have no interest in what this one is browsing. An owner nobody
   * knows simply offers nothing.
   */
  #viewPlaylists(connection: Connection, roomId: string, ownerPubkey: unknown): void {
    if (typeof ownerPubkey !== "string" || ownerPubkey.length === 0) {
      send(connection, error("malformed", "Op is missing an owner key."));
      return;
    }
    const playlists = Room.publicPlaylistsOf(this.#deps.rooms.get(roomId), ownerPubkey);
    send(connection, { type: "playlists", roomId, ownerPubkey, playlists });
  }

  /** A query needs an authenticated key but no room membership. */
  #handleQuery(connection: Connection, pubkey: string, query: Query): void {
    if (connection.pubkey === null) {
      send(connection, error("unknown-identity", "Authenticate before sending queries."));
      return;
    }
    if (connection.pubkey !== pubkey) {
      send(connection, error("unknown-identity", "Envelope key does not match this session."));
      return;
    }

    switch (query.type) {
      case "watch-rooms":
        connection.watchingList = true;
        send(connection, { type: "room-list", rooms: this.#deps.rooms.summaries() });
        return;

      case "unwatch-rooms":
        connection.watchingList = false;
        return;

      case "watch-room": {
        if (typeof query.roomId !== "string" || query.roomId.length === 0) {
          send(connection, error("malformed", "Query is missing a room id."));
          return;
        }
        // One room at a time: the second watch replaces the first.
        connection.watchingRoomId = query.roomId;
        const { rooms, clock } = this.#deps;
        send(connection, {
          type: "room-detail",
          snapshot: Room.projectSnapshot(rooms.get(query.roomId), pubkey, clock.now()),
        });
        return;
      }

      case "unwatch-room":
        if (typeof query.roomId !== "string" || query.roomId.length === 0) {
          send(connection, error("malformed", "Query is missing a room id."));
          return;
        }
        if (connection.watchingRoomId === query.roomId) connection.watchingRoomId = null;
        return;
    }
  }

  #joinRoom(connection: Connection, pubkey: string, username: string, roomId: string): void {
    if (connection.roomId !== null && connection.roomId !== roomId) {
      this.#leaveRoom(connection, pubkey, connection.roomId);
    }
    const { rooms, clock } = this.#deps;
    rooms.commit(Room.join(rooms.get(roomId, clock.now()), pubkey, username));
    connection.roomId = roomId;
    this.#publish(roomId);
  }

  #leaveRoom(connection: Connection, pubkey: string, roomId: string): void {
    if (connection.roomId !== roomId) {
      send(connection, error("not-in-room", "You are not in that room."));
      return;
    }
    connection.roomId = null;

    const { rooms } = this.#deps;
    if (!this.#stillPresent(pubkey, roomId)) {
      rooms.commit(Room.leave(rooms.get(roomId), pubkey));
    }
    this.#publish(roomId);
    // The leaver gets a final view of the room they are no longer in, so their
    // UI can settle rather than keep the last shared snapshot.
    send(connection, {
      type: "room-state",
      snapshot: Room.projectSnapshot(Room.emptyRoom(roomId), pubkey, this.#deps.clock.now()),
    });
  }

  /** True when some other live socket still holds this key in this room. */
  #stillPresent(pubkey: string, roomId: string): boolean {
    return connectionsInRoom(this.#connections, roomId).some(
      (other) => other.pubkey === pubkey,
    );
  }

  /**
   * Tell everyone who cares that this room moved.
   *
   * Three audiences: its members, whoever is peeking at it, and whoever is
   * watching the room list. One snapshot per recipient, because myQueue is the
   * recipient's own.
   *
   * Every committed change reaches here, so this is also where the track-end
   * timer is re-pointed: one place, and no path can move the pointer without
   * the clock hearing about it.
   */
  #publish(roomId: string): void {
    const { rooms, clock } = this.#deps;
    this.#roomClock.arm(roomId);
    const state = rooms.get(roomId);
    const now = clock.now();

    for (const connection of connectionsInRoom(this.#connections, roomId)) {
      if (connection.pubkey === null) continue;
      send(connection, {
        type: "room-state",
        snapshot: Room.projectSnapshot(state, connection.pubkey, now),
      });
    }

    // Watchers see position, so a seek or a pause is news to them.
    for (const connection of connectionsWatchingRoom(this.#connections, roomId)) {
      if (connection.pubkey === null) continue;
      send(connection, {
        type: "room-detail",
        snapshot: Room.projectSnapshot(state, connection.pubkey, now),
      });
    }

    this.#publishList(roomId);
  }

  /** Push a fresh room list, but only when this room's row actually changed. */
  #publishList(roomId: string): void {
    const { rooms } = this.#deps;
    const previous = this.#lastSummary.get(roomId);

    if (!rooms.has(roomId)) {
      // Gone from the registry: deserted, and the list must lose the row.
      if (previous === undefined) return;
      this.#lastSummary.delete(roomId);
    } else {
      const current = summarize(rooms.get(roomId));
      if (previous !== undefined && sameSummary(previous, current)) return;
      this.#lastSummary.set(roomId, current);
    }

    const summaries = rooms.summaries();
    for (const connection of connectionsWatchingList(this.#connections)) {
      send(connection, { type: "room-list", rooms: summaries });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthPayload(value: unknown): value is AuthPayload {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "register" || type === "hello";
}

/** Map an envelope failure onto the error codes the protocol allows. */
function failureCode(reason: string): ErrorCode {
  if (reason === "bad-signature") return "bad-signature";
  // A skewed clock is not a malformed message; say so, or the client has no
  // way to tell "fix your clock" from "your code is wrong".
  if (reason === "stale-timestamp" || reason === "future-timestamp") {
    return "stale-envelope";
  }
  return "malformed";
}

function error(code: ErrorCode, message: string): ErrorEvent {
  return { type: "error", code, message };
}

/** A dead socket must not break the loop that is telling everyone else. */
function send(connection: Connection, event: ServerEvent): void {
  try {
    connection.socket.send(JSON.stringify(event));
  } catch {
    // Nothing to do: the close handler will reap this connection.
  }
}
