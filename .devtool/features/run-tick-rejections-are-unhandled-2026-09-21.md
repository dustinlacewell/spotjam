---
id: "run-tick-rejections-are-unhandled-2026-09-21"
status: "backlog"
priority: "low"
assignee: null
epic: "playback-driver"
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:45.166Z"
completedAt: null
labels: ["created-by-ai", "sync", "bug"]
order: "a22"
---
# Unguarded void this.tick() / .finally() chains swallow and leak rejections

`tick()` (apps/desktop/src/lib/playback/driver.ts:114,117,119,166,188)
only guards `runTick` with `ticking`; `runTick` itself has no try/catch
around the pure + room-reading portions (`room.getPlaybackPointer()`,
`room.serverNow()`, `desiredAt`, `reconcile`, `classify`). Any throw
(malformed pointer, bad queue entry) rejects `tick()`; the
`void this.tick()` call sites never attach a catch, and in `schedule()`
the rejection escapes through `.finally(() => this.schedule())`.

Failure mode: an "Unhandled promise rejection" per tick — the driver
keeps ticking, but every tick fails and the UI silently stops
reconciling with no surfaced error.

Fix: wrap the body of `runTick` in try/catch (report and return), or
attach `.catch` to the `void this.tick()` call sites.