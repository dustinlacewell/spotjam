---
id: "pasted-text-containing-stale-prefix-can-demote-bridge-2026-09-21"
status: "backlog"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:38.410Z"
completedAt: null
labels: ["created-by-ai", "bridge", "bug"]
order: "a4"
---
# User paste containing the stale-error prefix can demote a healthy bridge

`normalise_playlist_uri` (apps/desktop/src-tauri/src/spotify/playlist_api.rs:96-98,161)
echoes the caller's raw paste into its error, which flows through
`with_client_typed`'s `describe` into `demote_if_meaningless`
(session.rs:121), where `message.contains(STALE_PREFIX)`
(`spotjam-walk-failed:`) substring-matches. A paste containing that
literal prefix on a healthy bridge sets state `Lost` — and combined
with the `watch_ready` wedge (see the demote-to-Lost card) the session
then stays lost.

Failure mode: contrived trigger, but the codebase's own standard is
"nothing a paste can plausibly contain", and this one message is
provably not the page's words — it embeds the caller's input.

Fix: classify before the URI ever reaches the session — mark
parser/validation rejections as "never demote" (a distinct error
variant that `with_client_typed` skips when describing), matching the
treatment the existing tests expect for non-URL pastes.