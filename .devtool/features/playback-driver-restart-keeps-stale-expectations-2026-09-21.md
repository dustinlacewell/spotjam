---
id: "playback-driver-restart-keeps-stale-expectations-2026-09-21"
status: "backlog"
priority: "high"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:39.849Z"
completedAt: null
labels: ["created-by-ai", "sync", "bug"]
order: "a2V"
---
# PlaybackDriver.stop() leaves stale prev/outstanding; first tick after restart detaches

`PlaybackDriver.stop()` (apps/desktop/src/lib/playback/driver.ts:123-131)
clears timers and subscriptions but never calls `forget()` (which bumps
`generation` and drops `prev`/`outstanding`), and `start()` (105-121)
doesn't either. If the driver is stopped and restarted (leaving and
rejoining a room, teardown/remount cycle) while `bridgeState` is still
`"ready"`, the first tick compares a minutes-old `prev` against the
fresh reading. The room's track has changed and the position is far off
the projection; nothing outstanding explains it, so `classify` returns
`"user"`, `setMode("user-took-player")` fires, and the driver detaches.

Failure mode: rejoining a room silently drops sync control — the user
must manually re-attach even though nobody touched the player.

Fix: call `this.forget()` (and reset `stuck`/`lastItemId`) in `stop()`,
or in `start()` when the previous run ended.