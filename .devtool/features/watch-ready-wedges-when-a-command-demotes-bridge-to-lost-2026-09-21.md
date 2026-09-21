---
id: "watch-ready-wedges-when-a-command-demotes-bridge-to-lost-2026-09-21"
status: "backlog"
priority: "high"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:32.220Z"
completedAt: null
labels: ["created-by-ai", "bridge", "bug"]
order: "a0"
---
# watch_ready wedges permanently when a command demotes the bridge to Lost

`demote_on` (apps/desktop/src-tauri/src/spotify/session.rs:426-436) sets
`BridgeState::Lost` when a command fails with a stale-page error, but the
supervisor is parked inside `watch_ready`'s `select!`
(session.rs:486-539), which only wakes on `client.closed()` or a
broadcast event. An in-place xpui reload keeps the WebSocket open and
has already delivered `executionContextsCleared` (that is how the
command failed via the classifier in the first place), so no further
event and no socket close ever arrive.

Failure mode: the bridge reports `lost`, every command fails, and the
supervisor never runs `connect_attempt` again — a permanent outage
until the app restarts. The tests at session.rs:913-924 assert only
that the state changed, not that the supervisor escapes `watch_ready`.

Fix: add a `watch_ready` arm on `self.subscribe().changed()` that
returns when the observed state becomes `Lost`, letting the supervisor
reconnect — or have `demote_on` drop the client so `watch_ready`'s
cloned client handle observes the sweep.