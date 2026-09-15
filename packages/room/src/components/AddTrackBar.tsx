import { useState } from "react";
import { Button, HintLine, TextField } from "@spotjam/ui";
import styles from "./AddTrackBar.module.css";

export function AddTrackBar({
  onAdd,
  placeholder = "Paste a Spotify track or playlist link...",
  buttonLabel = "Add to queue",
  status = null,
}: {
  onAdd: (link: string) => string | null;
  placeholder?: string;
  buttonLabel?: string;
  /** Transient line from an in-flight import, shown where the error goes. */
  status?: string | null;
}) {
  const [linkInput, setLinkInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!linkInput.trim()) return;
    const errorMessage = onAdd(linkInput);
    if (errorMessage) {
      setError(errorMessage);
      return;
    }
    setLinkInput("");
    setError(null);
  }

  return (
    <div className={styles.bar}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <TextField
            value={linkInput}
            onChange={(value) => {
              setLinkInput(value);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            size="md"
            spellCheck={false}
          />
        </div>
        <Button type="submit" size="md" disabled={!linkInput.trim()}>
          {buttonLabel}
        </Button>
      </form>
      <HintLine tone={error ? "error" : "muted"} reserveSpace={false}>
        {error ?? status}
      </HintLine>
    </div>
  );
}
