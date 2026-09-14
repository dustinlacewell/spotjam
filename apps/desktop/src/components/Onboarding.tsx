import { useState } from "react";
import { isValidUsername, USERNAME_MAX, USERNAME_MIN } from "@spotjam/protocol";
import type { StoredIdentity } from "../lib/identity";
import { createIdentity, identityExportPath, importIdentity } from "../lib/identity";
import { pickIdentityFile } from "../lib/identity-file-picker";
import styles from "./Onboarding.module.css";

type Mode = "create" | "import";

/**
 * Why a typed name is not yet a usable one. Null means it is fine — the form
 * stays quiet until the user has typed enough to be judged.
 */
function usernameProblem(value: string): string | null {
  if (value === "") return null;
  if (value.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters.`;
  if (value.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters.`;
  if (!/^[a-zA-Z0-9]/.test(value)) return "Start with a letter or a number.";
  if (!isValidUsername(value)) return "Letters, numbers, underscore and hyphen only.";
  return null;
}

/**
 * First-run gate. The key is the account, so this screen either mints one or
 * adopts one from a backup — there is nothing to log into.
 */
export function Onboarding({ onReady }: { onReady: (identity: StoredIdentity) => void }) {
  const [mode, setMode] = useState<Mode>("create");

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.mark}>
          <span className={styles.markDot} />
          spotjam
        </div>
        <p className={styles.tagline}>Your key is your account.</p>

        <div className={styles.modes}>
          <button
            type="button"
            className={mode === "create" ? styles.modeActive : styles.mode}
            onClick={() => setMode("create")}
          >
            New identity
          </button>
          <button
            type="button"
            className={mode === "import" ? styles.modeActive : styles.mode}
            onClick={() => setMode("import")}
          >
            I have one
          </button>
        </div>

        {mode === "create" ? (
          <CreateIdentity onReady={onReady} />
        ) : (
          <ImportIdentity onReady={onReady} />
        )}
      </div>
    </div>
  );
}

function CreateIdentity({ onReady }: { onReady: (identity: StoredIdentity) => void }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ identity: StoredIdentity; path: string } | null>(null);

  const trimmed = username.trim();
  const problem = usernameProblem(trimmed);
  const canSubmit = isValidUsername(trimmed) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const identity = await createIdentity(trimmed);
      // The path is shown before handing control back: this is the only moment
      // the user is guaranteed to be looking, and losing the file loses the
      // account.
      setCreated({ identity, path: await identityExportPath() });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className={styles.form}>
        <p className={styles.notice}>
          Back this file up. It is the only copy of your key, and it cannot be reissued.
        </p>
        <code className={styles.path}>{created.path}</code>
        <button className={styles.button} type="button" onClick={() => onReady(created.identity)}>
          Continue
        </button>
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <input
        className={styles.input}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Pick a name"
        autoFocus
        spellCheck={false}
        maxLength={USERNAME_MAX}
      />
      <p className={styles.hint}>{problem ?? error ?? ""}</p>
      <button className={styles.button} type="submit" disabled={!canSubmit}>
        {busy ? "Generating…" : "Create identity"}
      </button>
    </form>
  );
}

function ImportIdentity({ onReady }: { onReady: (identity: StoredIdentity) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = path.trim();
  const canSubmit = trimmed !== "" && !busy;

  async function browse() {
    const picked = await pickIdentityFile();
    if (picked) setPath(picked);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onReady(await importIdentity(trimmed));
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <div className={styles.row}>
        <input
          className={styles.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Path to identity.json"
          spellCheck={false}
        />
        <button className={styles.browse} type="button" onClick={() => void browse()}>
          Browse
        </button>
      </div>
      <p className={styles.hint}>{error ?? ""}</p>
      <button className={styles.button} type="submit" disabled={!canSubmit}>
        {busy ? "Importing…" : "Use this identity"}
      </button>
    </form>
  );
}
