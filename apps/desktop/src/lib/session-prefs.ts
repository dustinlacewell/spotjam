const STORAGE_KEY = "spotjam.prefs";

export interface SessionPrefs {
  /** Stable identity for this install. Keys this user's queue in the shared doc. */
  userId: string;
  username: string;
  lastRoomId: string;
}

/**
 * Reads the remembered identity, username and room code. The userId is minted
 * on first read and written straight back, so every later call — and every
 * later run — sees the same one.
 */
export function loadSessionPrefs(): SessionPrefs {
  const stored = readStored();
  if (stored.userId) return stored;
  const minted = { ...stored, userId: crypto.randomUUID() };
  saveSessionPrefs(minted);
  return minted;
}

export function saveSessionPrefs(prefs: SessionPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode, quota). Remembering is best-effort.
  }
}

function readStored(): SessionPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { userId: "", username: "", lastRoomId: "" };
    const parsed = JSON.parse(raw) as Partial<SessionPrefs>;
    return {
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      username: typeof parsed.username === "string" ? parsed.username : "",
      lastRoomId: typeof parsed.lastRoomId === "string" ? parsed.lastRoomId : "",
    };
  } catch {
    return { userId: "", username: "", lastRoomId: "" };
  }
}
