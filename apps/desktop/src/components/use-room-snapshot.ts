import { useCallback, useEffect, useState } from "react";
import type {
  ConnectionStatus,
  Participant,
  PlaybackPointer,
  Progress,
  QueueItem,
  Room,
  SessionEntry,
} from "../lib/room";

export interface RoomSnapshot {
  status: ConnectionStatus;
  participants: Participant[];
  sessionQueue: SessionEntry[];
  pointer: PlaybackPointer;
  leaderProgress: Progress | null;
  myQueue: QueueItem[];
  queueOf: (userId: string) => QueueItem[];
}

/**
 * Subscribes to the room and re-reads every getter on each change.
 * The tick counter is the only state: Room owns the data, this hook owns
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

  const queueOf = useCallback((userId: string) => room.queueOf(userId), [room]);

  return {
    status,
    participants: room.participants(),
    sessionQueue: room.sessionQueue(),
    pointer: room.getPlaybackPointer(),
    leaderProgress: room.leaderProgress(),
    myQueue: room.myQueue(),
    queueOf,
  };
}
