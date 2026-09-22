---
id: "stuck-chips-go-stale-across-driver-restart-2026-09-21"
status: "done"
priority: "medium"
assignee: null
epic: "playback-driver"
dueDate: null
created: "2026-09-21T20:35:00.000Z"
modified: "2026-09-22T01:17:45.976Z"
completedAt: "2026-09-22T01:17:45.976Z"
labels: ["created-by-ai", "sync", "bug"]
order: "a1002"
---
# stop() resets lastStuck without publishStuck(): stuck chips go stale across a restart

`PlaybackDriver.stop()` (apps/desktop/src/lib/playback/driver.ts) resets
`stuck = freshStuck()` and `lastStuck = []` silently — it never calls
`publishStuck()`. Every chip shown by way of `onStuckChange` therefore
keeps displaying the stopped run's "Spotify would not take" verdicts
after the driver stops; nothing clears them until the next run's first
`publishStuck()` fires, which only happens when the set actually changes
(or never, if nothing gets stuck again).

Failure mode: a driver restart leaves the stuck chip UI frozen on the
previous run's targets.

Fix: in `stop()`, reset `stuck` and call `publishStuck()` instead of
assigning `lastStuck` directly — the publish diffs against the previous
`lastStuck` and tells the listeners the set is now empty.