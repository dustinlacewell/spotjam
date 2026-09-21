---
id: "debug-only-tauri-command-exposes-app-state-without-the-inspector-2026-09-21"
status: "backlog"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T18:30:00.000Z"
modified: "2026-09-21T18:30:00.000Z"
completedAt: null
labels: ["created-by-ai", "devex"]
order: null
---
# Debug-only Tauri command/HTTP endpoint exposing app state without the inspector

The app's webview is WebKitGTK on Linux — no CDP, and the WebKit remote inspector is not attachable by tooling (see `docs/desktop/debugging-the-app.md`, "The app webview" — raw HTTP/websocket to the inspector port was attempted and failed). The result is that nobody — human or agent — can read the app's real state (bridge state, room session, driver mode) without eyeballing the UI.

Task: in debug builds only, expose a read-only surface that reports:
- `spotify_bridge_state` (the command already exists — `apps/desktop/src-tauri/src/spotify/`),
- the current room session (server URL, room id, participants, connection state),
- driver mode and last observation (playback/).

A Tauri command is sufficient for agent use via invoke; a localhost HTTP debug endpoint gated behind a dev-build flag is the more general form. Keep it read-only. Auth is not required in debug builds. Explicitly out of scope: any headless app mode.

Consumers: live-testing sessions (this is what would have replaced the "I can't open devtools" gap in the 2026-09-21 frontend-chain verification) and human debugging.

Related: kanban t_0efa744f.