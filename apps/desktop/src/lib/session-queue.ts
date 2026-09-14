import type { Participant, QueueItem, SessionEntry } from "./room";

/** The broadcasters, in the fixed order the round-robin walks: clientId ascending. */
export function broadcasterOrder(participants: Participant[]): Participant[] {
  return participants
    .filter((p) => p.broadcasting)
    .slice()
    .sort((a, b) => a.clientId - b.clientId);
}

/**
 * Flattens the broadcasters' individual queues into the single play order
 * the room will follow: one track per broadcaster per turn, starting with
 * the broadcaster AFTER `lastOwnerId`, skipping anyone who has run out.
 * Pure and deterministic — same inputs, same order, on every peer.
 */
export function projectSessionQueue(
  broadcasters: Participant[],
  queues: Record<string, QueueItem[]>,
  lastOwnerId: string | null,
): SessionEntry[] {
  if (broadcasters.length === 0) return [];

  const cursors = broadcasters.map((owner) => ({
    owner,
    items: queues[owner.userId] ?? [],
    next: 0,
  }));

  const entries: SessionEntry[] = [];
  let turn = startIndexAfter(broadcasters, lastOwnerId);

  let exhausted = 0;
  while (exhausted < cursors.length) {
    const cursor = cursors[turn];
    turn = (turn + 1) % cursors.length;

    const item = cursor.items[cursor.next];
    if (item === undefined) {
      exhausted += 1;
      continue;
    }
    cursor.next += 1;
    exhausted = 0;
    entries.push({
      item,
      ownerId: cursor.owner.userId,
      ownerName: cursor.owner.username,
    });
  }

  return entries;
}

/** Index of the broadcaster whose turn follows the owner of the last played track. */
function startIndexAfter(broadcasters: Participant[], lastOwnerId: string | null): number {
  if (lastOwnerId === null) return 0;
  const lastIndex = broadcasters.findIndex((p) => p.userId === lastOwnerId);
  if (lastIndex === -1) return 0;
  return (lastIndex + 1) % broadcasters.length;
}
