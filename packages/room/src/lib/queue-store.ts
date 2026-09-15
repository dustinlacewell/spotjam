import type { QueueItem } from "@spotjam/protocol";

/**
 * A member's queue lives in server memory only. A deploy restarts the server
 * and every queue in it vanishes. This is the client's own copy, per room, so
 * a rejoin can hand it back.
 *
 * Reads and writes are best-effort, like the playlists store: a blocked or
 * corrupt store degrades to an empty queue rather than breaking the app.
 */
export function loadQueue(roomId: string): QueueItem[] {
  try {
    const raw = localStorage.getItem(keyFor(roomId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // One bad entry means the stored copy is not what it claims to be, so
    // none of it is trusted -- a partial queue restore is worse than none.
    return parsed.every(isQueueItem) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveQueue(roomId: string, items: QueueItem[]): void {
  try {
    localStorage.setItem(keyFor(roomId), JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode, quota). Persisting is best-effort.
  }
}

function keyFor(roomId: string): string {
  return `spotjam.queue.${roomId}`;
}

function isQueueItem(value: unknown): value is QueueItem {
  const item = value as Partial<QueueItem> | null;
  return (
    typeof item?.id === "string" &&
    typeof item.uri === "string" &&
    typeof item.trackId === "string"
  );
}
