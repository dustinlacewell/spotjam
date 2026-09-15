import { useEffect, useState } from "react";
import type { RoomSummary } from "@spotjam/protocol";
import { isRoomListEvent, type Connection } from "../lib/connection";

/**
 * The live room list, kept current by the server.
 *
 * The watch is re-sent on every `onReady` because a reconnect gives a fresh
 * socket, and a subscription belongs to the socket that asked for it.
 */
export function useLiveRooms(connection: Connection): RoomSummary[] {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  useEffect(() => {
    const watch = () => connection.send({ type: "watch-rooms" });

    const unsubscribeEvent = connection.onEvent((event) => {
      if (isRoomListEvent(event)) setRooms(event.rooms);
    });
    const unsubscribeReady = connection.onReady(watch);
    watch();

    return () => {
      unsubscribeEvent();
      unsubscribeReady();
      connection.send({ type: "unwatch-rooms" });
    };
  }, [connection]);

  return rooms;
}
