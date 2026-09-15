import { useState } from "react";
import { Button, CenteredCardPage, HintLine, Mark, TextField } from "@spotjam/ui";
import type { Connection } from "../lib/connection";
import { useLiveRooms } from "./use-live-rooms";
import { VersionButton } from "./VersionButton";
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
    <CenteredCardPage>
      <Mark size="lg" />
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
        <TextField
          value={roomId}
          onChange={setRoomId}
          placeholder="Room code"
          align="center"
          size="lg"
          autoFocus
          spellCheck={false}
        />
        <Button type="submit" disabled={!canJoin}>
          Join room
        </Button>
        <Button type="button" variant="secondary" onClick={onBrowse}>
          Browse rooms
        </Button>
        <HintLine tone="muted" reserveSpace={false}>
          {rooms.length} public {rooms.length === 1 ? "room" : "rooms"}
        </HintLine>
      </form>
      <VersionButton />
    </CenteredCardPage>
  );
}
