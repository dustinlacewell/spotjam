const STORAGE_KEY = "spotjam.prefs";

export interface SessionPrefs {
  lastRoomId: string;
}

/**
 * Reads the remembered room code.
 *
 * Identity used to live here too. The keypair on disk is the account now, so
 * this holds nothing but the last room the user was in.
 */
export function loadSessionPrefs(): SessionPrefs {
  return readStored();
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
    if (!raw) return { lastRoomId: "" };
    const parsed = JSON.parse(raw) as Partial<SessionPrefs>;
    return {
      lastRoomId: typeof parsed.lastRoomId === "string" ? parsed.lastRoomId : "",
    };
  } catch {
    return { lastRoomId: "" };
  }
}
