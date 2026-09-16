import { Button, Thumbnail } from "@spotjam/ui";
import { positionAt, type RoomSnapshot, type RoomSummary } from "@spotjam/protocol";
import type { Connection } from "../lib/connection";
import { formatClock, useTrackMetadata, SessionQueueList } from "@spotjam/room";
import { useRoomDetail } from "./use-room-detail";
import styles from "./RoomDetailPane.module.css";

/** What a room is playing and has queued, and the way into it. */
export function RoomDetailPane({
  connection,
  room,
  onJoin,
}: {
  connection: Connection;
  room: RoomSummary | null;
  onJoin: (roomId: string) => void;
}) {
  const snapshot = useRoomDetail(connection, room?.roomId ?? null);

  if (room === null) {
    return (
      <aside className={styles.pane}>
        <div className={styles.placeholder}>Select a room</div>
      </aside>
    );
  }

  return (
    <aside className={styles.pane}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.name}>{room.roomId}</div>
          <div className={styles.meta}>
            {room.listeners} {room.listeners === 1 ? "listener" : "listeners"}
          </div>
        </div>
        <Button variant="primary" size="sm" onClick={() => onJoin(room.roomId)}>
          Join
        </Button>
      </div>
      <NowPlaying snapshot={snapshot} />
      <div className={styles.queue}>
        {snapshot === null || snapshot.sessionQueue.length === 0 ? (
          <div className={styles.placeholder}>Nothing queued</div>
        ) : (
          <SessionQueueList entries={snapshot.sessionQueue} />
        )}
      </div>
    </aside>
  );
}

/** The pointer's track as a watcher sees it: no controls, no seeking. */
function NowPlaying({ snapshot }: { snapshot: RoomSnapshot | null }) {
  const uri = snapshot?.pointer.uri ?? "";
  const metadata = useTrackMetadata(uri);
  if (snapshot === null || snapshot.pointer.itemId === null) return null;

  const { pointer, participants } = snapshot;
  const owner = participants.find((p) => p.pubkey === pointer.ownerPubkey)?.username;

  // The snapshot is stamped with the server's own clock, so the position is
  // read at that instant. No offset is needed and none is available: a watcher
  // has not joined this room, so it folds no clock of its own. The reading is
  // frozen between pushes, which is what a watcher's readout was before too.
  const positionMs = positionAt(pointer, snapshot.serverTime);

  return (
    <div className={styles.nowPlaying}>
      <Thumbnail src={metadata?.thumbnailUrl} size={56} />
      <div className={styles.info}>
        <div className={styles.label}>{pointer.isPaused ? "Paused" : "Now playing"}</div>
        <div className={styles.title}>{metadata?.title ?? pointer.uri}</div>
        <div className={styles.artist}>{metadata?.artist ?? " "}</div>
        <div className={styles.meta}>
          {owner !== undefined && <span>from {owner}</span>}
          {pointer.durationMs > 0 && (
            <span>
              {formatClock(positionMs)} / {formatClock(pointer.durationMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
