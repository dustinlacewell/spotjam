import styles from "./BroadcastToggle.module.css";

export function BroadcastToggle({
  broadcasting,
  onToggle,
}: {
  broadcasting: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={broadcasting ? styles.pillOn : styles.pill}
      onClick={onToggle}
      aria-pressed={broadcasting}
      title={
        broadcasting
          ? "You are broadcasting. Your queue feeds the session."
          : "Start broadcasting to feed your queue into the session."
      }
    >
      <span className={styles.dot} />
      {broadcasting ? "Broadcasting" : "Broadcast"}
    </button>
  );
}
