---
id: "server-dedupes-tracks-while-client-mints-unique-ids-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:48.489Z"
completedAt: null
labels: ["created-by-ai", "queue", "protocol", "bug"]
order: "a20G"
---
# Client and server disagree on duplicate tracks in a queue

`toQueueItems` (packages/protocol/src/tracks.ts:19-31) mints a fresh
`crypto.randomUUID()` per add; its comment promises "the same track can
sit in a queue more than once and still be addressed individually", and
`ops.ts:11` ("Fresh per add") agrees. But the server dedupes by
`trackId` via `appendUniqueTracks` (tracks.ts:9-31, "keeping one entry
per track", applied in room enqueue) — the second add of the same track
is silently dropped. One side of the protocol is wrong.

Failure mode: a user adds a track that is already in their queue;
nothing happens with no feedback. The minted ids suggest an independent
entry, so removes/moves can also target a stale expectation.

Fix: pick one semantics — either drop the dedupe in the server's
enqueue path, or make `toQueueItems`/the UI filter already-queued
tracks and say so in the protocol docs.