import { Pill } from "@spotjam/ui";
import styles from "./BroadcastToggle.module.css";

export function BroadcastToggle({
  broadcasting,
  onToggle,
}: {
  broadcasting: boolean;
  onToggle: () => void;
}) {
  return (
    <Pill
      active={broadcasting}
      tone="accent"
      onClick={onToggle}
      className={styles.pill}
      title={
        broadcasting
          ? "You are broadcasting. Your queue feeds the session."
          : "Start broadcasting to feed your queue into the session."
      }
    >
      {broadcasting ? "Broadcaster" : "Listener"}
    </Pill>
  );
}
