---
id: "bridge-state-initial-read-can-overwrite-newer-event-2026-09-21"
status: "done"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T21:52:47.866Z"
completedAt: "2026-09-21T21:52:47.923Z"
labels: ["created-by-ai", "sync", "bug"]
order: "a18"
---
# bridge-state initial read can overwrite a newer state event

`subscribe()` (apps/desktop/src/lib/bridge-state.ts:62-77) registers the
listener, then chains `invoke("spotify_bridge_state")` off the
`listen()` promise. The two sources are unordered: if Rust emits a
state-change event after the `spotify_bridge_state` command was
dispatched but before its response is applied, the response — the
*older* state — is fed to the listener last and overwrites the newer
event's state. The driver then ticks against the wrong bridge state
(e.g. believes `ready` when the bridge just went `lost`) until the next
state change, which may never come if the bridge stays put.

The module's own comment (lines 58-61) shows the author was aware of
exactly this lost-update window but only closed the listen-registration
half of it.

Fix: timestamp each reading and have the listener ignore an
initial-read result older than the last event; or apply the initial
read before the listener registration, re-reading on any event arriving
during registration.