---
id: "track-metadata-hooks-leak-unhandled-rejections-2026-09-21"
status: "done"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T21:53:07.269Z"
completedAt: "2026-09-21T21:53:07.269Z"
labels: ["created-by-ai", "bug"]
order: "a12"
---
# Track-metadata hooks leak unhandled promise rejections when the Spotify client is closed

`void trackMetadata.resolve(uri).then(...)` has no rejection handler at
packages/room/src/components/use-track-metadata.ts:14 and :34. The
resolver reaches the Spotify client over CDP; when the client is
closed/restarting (the documented failure mode for this bridge), the
promise rejects — an unhandled rejection on every tick where a track
URI is on screen. Same pattern in `useTrackMetadataMap`. Contrast:
`use-playlists.ts` and `enqueue.ts` handle rejections everywhere else.

Failure mode: console unhandled-rejection noise (and crash-report
dialogs in some runtimes) whenever Spotify is closed while a room is
open.

Fix: add a rejection handler that leaves the previous state (or a
sentinel) in place.