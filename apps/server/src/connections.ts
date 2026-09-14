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
}

export function newConnection(socket: Sendable): Connection {
  return { socket, pubkey: null, username: null, roomId: null };
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
