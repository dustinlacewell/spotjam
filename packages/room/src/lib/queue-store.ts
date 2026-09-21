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
    // An entry that would not survive the server's own validation is dropped
    // on its own, rather than discarding the whole queue: the restore is sent
    // as one enqueue op, and the server rejects the entire array if any item
    // in it fails `isQueueItem` -- the queue would then be lost for good.
    return parsed.filter(isQueueItem);
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

/**
 * The same shape the server demands (apps/server `handle-op.ts`): it rejects
 * a whole enqueue op when any item fails this check, so a stored entry the
 * server would refuse must never reach it. `durationMs` in particular is
 * what the server advances the playback pointer with -- a missing, zero, or
 * fractional one stalls the room, so it is not a cosmetic field.
 */
function isQueueItem(value: unknown): value is QueueItem {
  const item = value as Partial<QueueItem> | null;
  return (
    typeof item?.id === "string" &&
    item.id !== "" &&
    typeof item.uri === "string" &&
    item.uri !== "" &&
    typeof item.trackId === "string" &&
    item.trackId !== "" &&
    typeof item.durationMs === "number" &&
    Number.isInteger(item.durationMs) &&
    item.durationMs > 0
  );
}
