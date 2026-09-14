import { useState } from "react";
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
        <input
          className={styles.input}
          value={linkInput}
          onChange={(e) => {
            setLinkInput(e.target.value);
            if (error) setError(null);
          }}
          placeholder={placeholder}
          spellCheck={false}
        />
        <button className={styles.button} type="submit" disabled={!linkInput.trim()}>
          {buttonLabel}
        </button>
      </form>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : (
        status && <p className={styles.status}>{status}</p>
      )}
    </div>
  );
}
