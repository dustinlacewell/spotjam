---
id: "spotify-seek-rejects-fractional-positionms-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: "playback-driver"
dueDate: null
created: "2026-09-21T22:09:31.000Z"
modified: "2026-09-21T22:09:31.000Z"
completedAt: null
labels: ["created-by-ai", "bug"]
order: null
---
# spotify_seek rejects fractional positionMs

Live console warning 2026-09-21:

```
spotify command failed – spotify_seek: invalid args positionMs for
command spotify_seek: invalid type: floating point 44658.044189453125,
expected u64
```
(driver.ts, line 319)

Flow: `desiredAt` (apps/desktop/src/lib/playback/desired.ts:45)
computes `positionMs = positionAt(settled, serverNow)`, which
interpolates — fractional whenever `serverNow` is fractional.
`tauriCall` (apps/desktop/src/lib/playback/driver.ts:405) passes it
unrounded to `spotify_seek`; the Rust command declares
`positionMs: u64` and rejects the float.

Root-cause note: `serverNow` is `localNow + clock offset`; the EMA
clock-offset estimator in effect when this was observed (before the
window-max estimator landed) produced fractional offsets, so the float
reached `spotify_seek` on every drift-correction seek. Live testing
after the window-max estimator landed (commit `17382744`, "Fix clock
offset measured at frame arrival") did NOT reproduce the warning — the
window max is a whole sample, so `serverNow` is whole again. The
u64 boundary remains unguarded, so any future fractional positionMs
(e.g. a fractional offset reappearing upstream) would hit it again.

Suggested fix: integer-coerce at the `tauriCall` bridge boundary + a
`driver.test.ts` round-trip assertion that `spotify_seek` args are
integers under fractional `serverNow`.

Related: kanban t_236d4eec, playback-driver epic t_dde5a6d3.
