import { Pill } from "@spotjam/ui";
import styles from "./PublicToggle.module.css";

export function PublicToggle({
  isPublic,
  onToggle,
}: {
  isPublic: boolean;
  onToggle: () => void;
}) {
  return (
    <Pill
      active={isPublic}
      tone="accent"
      onClick={onToggle}
      className={styles.pill}
      title={
        isPublic
          ? "This playlist is public. Anyone in the room can open it from your page."
          : "This playlist is private. Make it public to let the room open it from your page."
      }
    >
      {isPublic ? "Public" : "Private"}
    </Pill>
  );
}
