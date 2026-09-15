import { EngravedText, ListRow, StatusDot, type StatusDotTone } from "@spotjam/ui";
import type { Participant, SessionEntry } from "@spotjam/protocol";
import styles from "./Sidebar.module.css";

export type Selection = "session" | string;

export function Sidebar({
  participants,
  sessionQueue,
  playingOwnerPubkey,
  selection,
  onSelect,
}: {
  participants: Participant[];
  /** Whose tracks are queued to play, so an empty-queue broadcaster can be told apart. */
  sessionQueue: SessionEntry[];
  playingOwnerPubkey: string | null;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const feeding = new Set(sessionQueue.map((entry) => entry.ownerPubkey));
  const broadcasters = participants.filter((p) => p.broadcasting);
  const listeners = participants.filter((p) => !p.broadcasting);

  return (
    <nav className={styles.sidebar}>
      <ListRow
        as="button"
        selected={selection === "session"}
        className={styles.row}
        onClick={() => onSelect("session")}
      >
        <span className={styles.iconSlot} />
        <span className={styles.name}>View Session Queue</span>
      </ListRow>

      <div className={styles.divider} />

      <p className={styles.sectionLabel}>Broadcasters</p>
      {broadcasters.length > 0 ? (
        <ul className={styles.list}>
          {broadcasters.map((participant) => (
            <ParticipantRow
              key={participant.pubkey}
              participant={participant}
              tone={feeding.has(participant.pubkey) ? "accent" : "warning"}
              title={feeding.has(participant.pubkey) ? "Broadcasting" : "Broadcasting — queue is empty"}
              pulse={participant.pubkey === playingOwnerPubkey}
              glow={participant.pubkey === playingOwnerPubkey}
              selected={selection === participant.pubkey}
              onSelect={() => onSelect(participant.pubkey)}
            />
          ))}
        </ul>
      ) : (
        <div className={styles.noOne}>
          <EngravedText>No broadcasters.</EngravedText>
        </div>
      )}

      <p className={styles.sectionLabel}>Listeners</p>
      {listeners.length > 0 ? (
        <ul className={styles.list}>
          {listeners.map((participant) => (
            <ParticipantRow
              key={participant.pubkey}
              participant={participant}
              tone="muted"
              title="Not broadcasting"
              glow={false}
              selected={selection === participant.pubkey}
              onSelect={() => onSelect(participant.pubkey)}
            />
          ))}
        </ul>
      ) : (
        <div className={styles.noOne}>
          <EngravedText>No listeners.</EngravedText>
        </div>
      )}
    </nav>
  );
}

function ParticipantRow({
  participant,
  tone,
  title,
  pulse = false,
  glow,
  selected,
  onSelect,
}: {
  participant: Participant;
  tone: StatusDotTone;
  title: string;
  pulse?: boolean;
  glow: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <ListRow as="button" selected={selected} className={styles.row} onClick={onSelect}>
        <span className={styles.iconSlot}>
          <StatusDot tone={tone} size={7} pulse={pulse} glow={glow} title={title} />
        </span>
        <span className={styles.name}>{participant.username}</span>
      </ListRow>
    </li>
  );
}
