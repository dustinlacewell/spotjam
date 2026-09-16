import { useCallback, useEffect, useState } from "react";
import type {
  Participant,
  PlaybackPointer,
  QueueItem,
  SessionEntry,
} from "@spotjam/protocol";
import type { ConnectionStatus, RoomError } from "../lib/room-client";
import type { Room } from "../ports/room";

export interface RoomSnapshot {
  status: ConnectionStatus;
  participants: Participant[];
  sessionQueue: SessionEntry[];
  pointer: PlaybackPointer;
  myQueue: QueueItem[];
  queueOf: (pubkey: string) => QueueItem[];
  /** The last typed error from the server, for the UI to surface. */
  error: RoomError | null;
}

/**
 * Subscribes to the room and re-reads every getter on each change.
 * The tick counter is the only state: the room owns the data, this hook owns
 * nothing but the invalidation signal.
 */
export function useRoomSnapshot(room: Room): RoomSnapshot {
  const [, setTick] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>(() => room.getStatus());

  useEffect(() => {
    setStatus(room.getStatus());
    setTick((n) => n + 1);
    const offChange = room.onChange(() => setTick((n) => n + 1));
    const offStatus = room.onStatus(setStatus);
    return () => {
      offChange();
      offStatus();
    };
  }, [room]);

  const queueOf = useCallback((pubkey: string) => room.queueOf(pubkey), [room]);

  return {
    status,
    participants: room.participants(),
    sessionQueue: room.sessionQueue(),
    pointer: room.getPlaybackPointer(),
    myQueue: room.myQueue(),
    queueOf,
    error: room.lastError(),
  };
}
