import { useState } from "react";
import styles from "./JoinRoom.module.css";

export function JoinRoom({
  initialUsername,
  initialRoomId,
  onJoin,
}: {
  initialUsername: string;
  initialRoomId: string;
  onJoin: (username: string, roomId: string) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [roomId, setRoomId] = useState(initialRoomId);

  const trimmedUsername = username.trim();
  const normalizedRoomId = roomId.trim().toLowerCase();
  const canJoin = trimmedUsername !== "" && normalizedRoomId !== "";

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
            if (canJoin) onJoin(trimmedUsername, normalizedRoomId);
          }}
        >
          <input
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Your name"
            autoFocus={initialUsername === ""}
            spellCheck={false}
            maxLength={32}
          />
          <input
            className={styles.input}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room code"
            autoFocus={initialUsername !== ""}
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
