import type { Participant } from "../lib/room";
import styles from "./Sidebar.module.css";

export type Selection = "session" | string;

export function Sidebar({
  participants,
  playingOwnerPubkey,
  selection,
  onSelect,
}: {
  participants: Participant[];
  playingOwnerPubkey: string | null;
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
        <span className={styles.name}>Session Queue</span>
      </button>

      <div className={styles.divider} />

      <ul className={styles.list}>
        {participants.map((participant) => (
          <li key={participant.pubkey}>
            <button
              type="button"
              className={
                selection === participant.pubkey ? styles.rowSelected : styles.row
              }
              onClick={() => onSelect(participant.pubkey)}
            >
              <span className={styles.iconSlot}>
                <span
                  className={participant.broadcasting ? styles.broadcastDot : styles.broadcastDotOff}
                  title={participant.broadcasting ? "Broadcasting" : "Not broadcasting"}
                />
              </span>
              <span className={styles.name}>{participant.username}</span>
              {participant.pubkey === playingOwnerPubkey && (
                <span className={styles.playingGlyph} title="Playing now">
                  ♪
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
