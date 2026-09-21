---
id: "reconnect-leaks-cdp-reader-task-and-websocket-2026-09-21"
status: "done"
priority: "high"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T07:51:22.915Z"
completedAt: "2026-09-21T07:51:22.915Z"
labels: ["created-by-ai", "bridge", "bug"]
order: "a1"
---
# Reconnect leaks one CDP reader task and WebSocket per replaced client

The reader task spawned in `connect`
(apps/desktop/src-tauri/src/spotify/cdp.rs:62-83) owns the read half of
the split WebSocket and only exits when `read.next()` returns `None` —
which requires the socket to close, which requires both halves dropped.
The reader owns the read half, so dropping the `CdpClient` (an
`Arc` refcount decrement) never closes the socket and never ends the
task. No `JoinHandle` is stored and nothing is aborted. The comment at
session.rs:388-392 ("dropping the last `Arc` also ends its reader
task") is wrong.

Failure mode: every reconnect (Spotify restart, page reload with socket
loss) leaks one live WebSocket, one spinning reader task, and one stale
`Runtime.enable` session against the Spotify client for the app's
lifetime. Long sessions of flapping reconnects accumulate dozens; the
client's debug port ends up with multiple simultaneous debugger
connections to the same target.

Fix: give `CdpClient` a shutdown signal (e.g.
`tokio_util::sync::CancellationToken`); in the reader `tokio::select!`
between `read.next()` and the token; cancel it from `Drop` of
`CdpClient` (or via a `close()` the session calls before dropping).