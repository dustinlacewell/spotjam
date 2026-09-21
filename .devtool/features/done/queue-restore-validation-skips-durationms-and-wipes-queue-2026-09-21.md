---
id: "queue-restore-validation-skips-durationms-and-wipes-queue-2026-09-21"
status: "done"
priority: "high"
assignee: null
epic: "queue-semantics"
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-22T00:33:03.109Z"
completedAt: "2026-09-22T00:33:03.109Z"
labels: ["created-by-ai", "queue", "protocol", "bug"]
order: "a101"
---
# Queue-restore validation omits durationMs, and the rejection wipes the stored queue

The client's `isQueueItem` (packages/room/src/lib/queue-store.ts:36-43)
checks only `id`/`uri`/`trackId`. The server's `isQueueItem`
(apps/server/src/handle-op.ts:149-151) additionally requires
`Number.isInteger(durationMs) && durationMs > 0`, and `handleOp`
(handle-op.ts:76) rejects the *entire* `items` array if any item fails.
A stored queue with one entry missing or corrupting `durationMs` (older
client version, partial write) passes local validation, is sent by
`RoomClient.#persistQueue` (apps/desktop/src/lib/room.ts:132-138) as
one enqueue op, is refused as `malformed`, and the following snapshot
(`myQueue: []`) then causes `saveQueue(roomId, [])` — permanently
destroying the stored copy.

Failure mode: after a server restart, a user's saved queue silently
vanishes, with only a lone "malformed" error on the server.

Fix: validate `durationMs` in queue-store's `isQueueItem`, and/or drop
invalid entries individually before sending the restore instead of
overwriting the store with the post-rejection snapshot.

## Resolution

queue-store's `isQueueItem` now mirrors the server's check exactly (`durationMs`
must be a positive integer, matching `isDuration` in apps/server/src/handle-op.ts),
and `loadQueue` drops invalid entries individually instead of discarding the whole
array. The stored queue therefore never contains an entry the server's whole-array
enqueue validation would refuse, so the restore-reject-then-wipe path is eliminated:
the "don't overwrite the store on rejection" defense is satisfied by validation
parity rather than by a snapshot guard.