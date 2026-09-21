---
id: "concurrent-set-next-track-can-queue-two-tracks-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: "queue-semantics"
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:36.774Z"
completedAt: null
labels: ["created-by-ai", "bridge", "queue", "bug"]
order: "a3"
---
# Concurrent set_next_track calls can leave two tracks queued

`set_next_track` is clear-then-add in two sequential awaits inside one
JS expression (apps/desktop/src-tauri/src/spotify/player_api.rs:233-242),
and commands are deliberately unsynchronized
(session.rs:444-449, mod.rs:186-193). Two concurrent invocations
interleave across evaluations: A `clearQueue`, B `clearQueue`,
A `addToQueue`, B `addToQueue` — two entries. The 500 ms queue-cache
debounce (player_api.rs:178-201) only protects sequential ticks; the
room-change hook and the 2 s sync tick can genuinely race.

Failure mode: the queue grows to two entries; Spotify then plays the
extra track — the user hears a duplicated/unordered next track after a
room change, recurring on every racing pair.

Fix: serialize `set_next_track` per session (a dedicated `Mutex<()>`
around the command, or session-level single-flight), or make the JS
atomic against concurrent replaces (page-side lock / last-write-wins
token carried in the expression).