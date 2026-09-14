import type { Participant } from "../lib/room";
import styles from "./Sidebar.module.css";

export type Selection = "session" | string;

export function Sidebar({
  participants,
  playingOwnerId,
  selection,
  onSelect,
}: {
  participants: Participant[];
  playingOwnerId: string | null;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <nav className={styles.sidebar}>
      <button
        type="button"
        className={selection === "session" ? styles.rowSelected : styles.row}
        onClick={() => onSelect("session")}
      >
        <span className={styles.iconSlot} />
        <span className={styles.name}>Session</span>
      </button>

      <div className={styles.divider} />

      <ul className={styles.list}>
        {participants.map((participant) => (
          <li key={participant.clientId}>
            <button
              type="button"
              className={
                selection === participant.userId ? styles.rowSelected : styles.row
              }
              onClick={() => onSelect(participant.userId)}
            >
              <span className={styles.iconSlot}>
                {participant.broadcasting && (
                  <span className={styles.broadcastDot} title="Broadcasting" />
                )}
              </span>
              <span className={styles.name}>{participant.username}</span>
              {participant.userId === playingOwnerId && (
                <span className={styles.playingGlyph} title="Playing now">
                  ♪
                </span>
              )}
              {participant.isMe && <span className={styles.youTag}>you</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
