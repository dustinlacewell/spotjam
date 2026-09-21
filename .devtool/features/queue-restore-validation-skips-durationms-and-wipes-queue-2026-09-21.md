---
id: "queue-restore-validation-skips-durationms-and-wipes-queue-2026-09-21"
status: "backlog"
priority: "high"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:47.192Z"
completedAt: null
labels: ["created-by-ai", "queue", "protocol", "bug"]
order: "a20V"
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