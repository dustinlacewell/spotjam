import type { RoomSnapshot, RoomSummary } from "@spotjam/protocol";
import type { Connection } from "../lib/connection";
import { formatClock } from "../lib/progress";
import { useTrackMetadata } from "../lib/use-track-metadata";
import { SessionQueueList } from "./SessionQueueList";
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
        <button type="button" className={styles.joinButton} onClick={() => onJoin(room.roomId)}>
          Join
        </button>
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

  const { pointer, progress, participants } = snapshot;
  const owner = participants.find((p) => p.pubkey === pointer.ownerPubkey)?.username;

  return (
    <div className={styles.nowPlaying}>
      <div className={styles.art}>
        {metadata?.thumbnailUrl && <img src={metadata.thumbnailUrl} alt="" />}
      </div>
      <div className={styles.info}>
        <div className={styles.label}>{pointer.isPaused ? "Paused" : "Now playing"}</div>
        <div className={styles.title}>{metadata?.title ?? pointer.uri}</div>
        <div className={styles.artist}>{metadata?.artist ?? " "}</div>
        <div className={styles.meta}>
          {owner !== undefined && <span>from {owner}</span>}
          {progress !== null && (
            <span>
              {formatClock(progress.positionMs)} / {formatClock(progress.durationMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
