import { ListRow, StatusDot } from "@spotjam/ui";
import type { Participant } from "@spotjam/protocol";
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
      <ListRow
        as="button"
        selected={selection === "session"}
        className={rowClass(selection === "session")}
        onClick={() => onSelect("session")}
      >
        <span className={styles.iconSlot} />
        <span className={styles.name}>Session Queue</span>
      </ListRow>

      <div className={styles.divider} />

      <ul className={styles.list}>
        {participants.map((participant) => (
          <li key={participant.pubkey}>
            <ListRow
              as="button"
              selected={selection === participant.pubkey}
              className={rowClass(selection === participant.pubkey)}
              onClick={() => onSelect(participant.pubkey)}
            >
              <span className={styles.iconSlot}>
                <StatusDot
                  tone={participant.broadcasting ? "accent" : "muted"}
                  size={7}
                  glow={participant.broadcasting}
                  title={
                    participant.broadcasting
                      ? "Broadcasting"
                      : "Not broadcasting"
                  }
                />
              </span>
              <span className={styles.name}>{participant.username}</span>
              {participant.pubkey === playingOwnerPubkey && (
                <span className={styles.playingGlyph} title="Playing now">
                  ♪
                </span>
              )}
            </ListRow>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** ListRow's "subtle" selection swaps the background; the sidebar also
 *  bolds the selected row. */
function rowClass(selected: boolean): string {
  return selected ? `${styles.row} ${styles.rowSelected}` : styles.row;
}
