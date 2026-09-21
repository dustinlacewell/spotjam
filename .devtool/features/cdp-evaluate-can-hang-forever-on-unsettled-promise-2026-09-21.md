---
id: "cdp-evaluate-can-hang-forever-on-unsettled-promise-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:35.371Z"
completedAt: null
labels: ["created-by-ai", "bridge", "bug"]
order: "a2"
---
# CDP evaluate can hang forever on a promise that never settles

`evaluate` (apps/desktop/src-tauri/src/spotify/cdp.rs:144-158) issues
`Runtime.evaluate` with `awaitPromise: true` and a `"timeout": 15000`
param. In the CDP protocol the `timeout` param applies to execution
(with `throwOnSideEffect`); a `timeout` param alone does not bound how
long CDP waits for an awaited promise to settle. If the page-side
promise never resolves (client hung, service wedged, promise orphaned
after a context clear mid-await), no response with that id ever arrives
and `rx.await` pends forever.

Failure mode: any player command (`play`, `pause`, `seek`, `observe`,
`get_state`, `set_next_track`) can hang its caller indefinitely.
`playlist_api` wraps everything in a 12 s `FETCH_TIMEOUT`
(playlist_api.rs:15,147), but the player/track paths have no outer
timeout — `spotify_observe` invoked by the sync driver silently stalls
that tick's task forever.

Fix: wrap the `rx.await` in `tokio::time::timeout` (15-20 s) and return
an error on expiry; drop the misleading `timeout` param or pair it with
`throwOnSideEffect` where acceptable.