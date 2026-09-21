---
id: "command-loop-appends-stale-expectation-after-forget-2026-09-21"
status: "backlog"
priority: "low"
assignee: null
epic: "playback-driver"
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:42.137Z"
completedAt: null
labels: ["created-by-ai", "sync", "bug"]
order: "a28"
---
# Command loop re-appends a stale expectation after forget()

In `drive()` (apps/desktop/src/lib/playback/driver.ts:343-347) the guard
`if (this.stopped || this.mode_ !== "attached" || generation !== this.generation) return;`
runs *before* `await this.send(command)`, but the append at line 346
runs *after* the await with no re-check. If `detach()`/`attach()`
(→ `forget()`, clearing `outstanding` and bumping `generation`) lands
during the `send` await, the just-sent command's expectation is
appended onto the freshly cleared list, resurrecting an expectation
from the pre-detach run.

Failure mode: after an immediate re-attach, up to ~3 s of phantom
in-flight expectation can suppress reconcile commands (pause/resume/
seek/queue-slot) — a brief audible divergence from the room.

Fix: re-check `this.mode_ === "attached" && generation === this.generation`
after `await this.send(...)` before appending.