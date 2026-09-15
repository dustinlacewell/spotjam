import { useEffect, useState } from "react";
import type { RoomSnapshot } from "@spotjam/protocol";
import { isRoomDetailEvent, type Connection } from "../lib/connection";

/**
 * One room's snapshot, watched without joining it.
 *
 * Null roomId means no watch and no snapshot, which is what a browser with
 * nothing selected wants. A snapshot for some other room is ignored: the
 * server allows one watched room per socket, so a stale push can still arrive
 * after the selection has moved on.
 */
export function useRoomDetail(
  connection: Connection,
  roomId: string | null,
): RoomSnapshot | null {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);

  useEffect(() => {
    if (roomId === null) return;

    const watch = () => connection.send({ type: "watch-room", roomId });

    const unsubscribeEvent = connection.onEvent((event) => {
      if (isRoomDetailEvent(event) && event.snapshot.roomId === roomId) {
        setSnapshot(event.snapshot);
      }
    });
    const unsubscribeReady = connection.onReady(watch);
    watch();

    return () => {
      unsubscribeEvent();
      unsubscribeReady();
      connection.send({ type: "unwatch-room", roomId });
      setSnapshot(null);
    };
  }, [connection, roomId]);

  return roomId === null ? null : snapshot;
}
