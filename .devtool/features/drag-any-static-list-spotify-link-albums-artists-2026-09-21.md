---
id: "drag-any-static-list-spotify-link-albums-artists-2026-09-21"
status: "backlog"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T02:50:00.000Z"
modified: "2026-09-21T06:09:13.154Z"
completedAt: null
labels: ["feature"]
order: "a4"
---
# Drag/paste any Spotify link that resolves to a static list — albums, artists, not just tracks and playlists

Currently `packages/room/src/lib/spotify-link.ts` only recognizes
track and playlist links; an album or artist link pasted into the
drop bar silently does nothing. Anything that resolves to a static
list of tracks should behave like a playlist: album links resolve to
the album's tracks (in album order); artist links resolve to the
artist's tracks (Spotify's own ordering); local/other list-like links
follow as they resolve.

Per the architecture rule (CLAUDE.md), the resolution happens through
the signed-in client: find the xpui service that serves album/artist
track lists (the playlist path uses `ListPlatformAPI`; there is a
corresponding API for album/artist contents — discover it the same
way, never by webpack module id).

Scope notes:
- Parser: accept `album` and `artist` share URLs and URIs (plus the
  `intl-xx/` prefix variant the track parser already handles), mapping
  to `spotify:album:` / `spotify:artist:`.
- Resolution: one service call per link type; batch like the playlist
  fetch; honor the same failure semantics as
  playlist-fetch-failures.md.
- Queue semantics follow the ratified duplicate-track decision (the
  queue-semantics decision card) — albums frequently repeat tracks
  across them.
- UI: the link type should be visible to the user before resolve
  completes (e.g. "Album — X tracks") rather than a silent wait.