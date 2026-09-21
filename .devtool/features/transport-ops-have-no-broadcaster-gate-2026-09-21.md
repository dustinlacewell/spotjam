---
id: "transport-ops-have-no-broadcaster-gate-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:54.352Z"
completedAt: null
labels: ["created-by-ai", "protocol"]
order: "a202"
---
# Decide whether transport ops should be gated: set-paused / seek / skip apply room-wide

`set-paused`, `seek`, and `skip` (apps/server/src/handle-op.ts:105-114)
apply to the shared playback pointer with no member check beyond
membership. Any member — including a non-broadcasting listener who
joined a moment ago — can pause, seek, or skip the room's shared
playback. `ops.ts:78` calls them "requests" but nothing in the protocol
says who may issue them.

Failure mode: one client can disrupt the room for everyone
(pause-spam, seek-to-zero loops). Whether this is "collaborative by
design" is undocumented.

Fix: if intentional, document it in the protocol; otherwise gate these
ops on `broadcasting` (or on the pointer's `ownerPubkey`).