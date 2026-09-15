import { useState } from "react";
import type { Connection } from "../lib/connection";
import { useLiveRooms } from "./use-live-rooms";
import styles from "./JoinRoom.module.css";

export function JoinRoom({
  connection,
  username,
  initialRoomId,
  onJoin,
  onBrowse,
}: {
  connection: Connection;
  /** Read-only: the identity owns the name, so there is nothing to type. */
  username: string;
  initialRoomId: string;
  onJoin: (roomId: string) => void;
  onBrowse: () => void;
}) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const rooms = useLiveRooms(connection);

  const normalizedRoomId = roomId.trim().toLowerCase();
  const canJoin = normalizedRoomId !== "";

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.mark}>
          <span className={styles.markDot} />
          spotjam
        </div>
        <p className={styles.tagline}>Spotify jams, on the spot!</p>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (canJoin) onJoin(normalizedRoomId);
          }}
        >
          <p className={styles.joiningAs}>
            Joining as <span className={styles.username}>{username}</span>
          </p>
          <input
            className={styles.input}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room code"
            autoFocus
            spellCheck={false}
          />
          <button className={styles.button} type="submit" disabled={!canJoin}>
            Join room
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onBrowse}>
            Browse rooms
          </button>
          <p className={styles.roomCount}>
            {rooms.length} public {rooms.length === 1 ? "room" : "rooms"}
          </p>
        </form>
      </div>
    </div>
  );
}
