/**
 * Deterministically picks which connected peer is responsible for
 * advancing the shared queue when a track ends. Every peer computes
 * this independently from the same awareness snapshot, so there is
 * no leader process or election handshake to keep in sync.
 */
export function isResponsibleForAdvancing(
  myClientId: number,
  connectedClientIds: number[],
): boolean {
  if (connectedClientIds.length === 0) return true;
  const lowest = Math.min(...connectedClientIds, myClientId);
  return myClientId === lowest;
}
