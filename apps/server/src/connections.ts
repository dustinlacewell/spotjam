// Connections — what the shell remembers about each open socket.
//
// A socket is anonymous until a signed `register` or `hello` proves a key. It
// sits in at most one room, so joining a second one leaves the first.

import type { PublicKeyHex } from "@spotjam/protocol";

/** The transport the shell needs. `ws` satisfies it; so does a test double. */
export interface Sendable {
  send(data: string): void;
}

export interface Connection {
  socket: Sendable;
  /** Set once the socket proves a key. Null means unauthenticated. */
  pubkey: PublicKeyHex | null;
  username: string | null;
  roomId: string | null;
  /** Subscribed to the live room list. Independent of membership. */
  watchingList: boolean;
  /** The one room this socket peeks at without joining, if any. */
  watchingRoomId: string | null;
}

export function newConnection(socket: Sendable): Connection {
  return {
    socket,
    pubkey: null,
    username: null,
    roomId: null,
    watchingList: false,
    watchingRoomId: null,
  };
}

/** Every connection currently in one room. Two sockets may share a key. */
export function connectionsInRoom(
  connections: Iterable<Connection>,
  roomId: string,
): Connection[] {
  const inRoom: Connection[] = [];
  for (const connection of connections) {
    if (connection.roomId === roomId && connection.pubkey !== null) inRoom.push(connection);
  }
  return inRoom;
}

/** Every connection subscribed to the room list. */
export function connectionsWatchingList(
  connections: Iterable<Connection>,
): Connection[] {
  const watching: Connection[] = [];
  for (const connection of connections) {
    if (connection.watchingList && connection.pubkey !== null) watching.push(connection);
  }
  return watching;
}

/** Every connection peeking at one room. A member may also be watching it. */
export function connectionsWatchingRoom(
  connections: Iterable<Connection>,
  roomId: string,
): Connection[] {
  const watching: Connection[] = [];
  for (const connection of connections) {
    if (connection.watchingRoomId === roomId && connection.pubkey !== null) {
      watching.push(connection);
    }
  }
  return watching;
}
