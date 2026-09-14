import { useState } from "react";
import styles from "./JoinRoom.module.css";

export function JoinRoom({
  username,
  initialRoomId,
  onJoin,
}: {
  /** Read-only: the identity owns the name, so there is nothing to type. */
  username: string;
  initialRoomId: string;
  onJoin: (roomId: string) => void;
}) {
  const [roomId, setRoomId] = useState(initialRoomId);

  const normalizedRoomId = roomId.trim().toLowerCase();
  const canJoin = normalizedRoomId !== "";

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.mark}>
          <span className={styles.markDot} />
          spotjam
        </div>
        <p className={styles.tagline}>One queue. Everyone's speakers.</p>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (canJoin) onJoin(normalizedRoomId);
          }}
        >
          <p className={styles.tagline}>Joining as {username}</p>
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
        </form>
      </div>
    </div>
  );
}
