Status: not built — proposal.

# Why move the room server to Colyseus

## What the snapshot broadcast cannot do cheaply

`apps/server/src/session.ts#publish` builds one `RoomSnapshot` per recipient on every
committed op. Cost per op is `members × snapshot size`. Every op re-sends every
participant row and the whole session queue, however small the change was.
Each new per-member field (avatar, reactions) either grows the snapshot or repeats the
`playlistsRevision` workaround: a counter in the snapshot plus a request/reply pair.
A reconnect is a fresh socket, `hello`, and `join-room`; the seat is lost at once.
This is the design's stated trade (`packages/protocol/src/events.ts` header). It stops
paying at Turntable scale.

## What Colyseus gives

- Delta sync. `@colyseus/schema` sends only changed fields, in binary, with
  `onAdd`/`onRemove`/`listen` callbacks on the client.
- Per-client visibility. `StateView` hides a `.view()` field from every client whose
  view does not hold the instance. That is `myQueue` with no per-recipient projection,
  and public playlists with no request/reply and no staleness.
- Seats. `onDrop` → `allowReconnection(client, seconds)` → `onReconnect` keeps a member
  across a socket drop.
- Messages. `this.broadcast`, `client.send`, a `messages` map with `validate(zod, fn)`.
- Room list. `LobbyRoom` + `enableRealtimeListing()` replaces `watch-rooms`,
  `room-list`, and the `#lastSummary` gate.
- `@colyseus/testing` boots the real server in-process.

## What it costs

- A new wire format. Clients need `@colyseus/sdk`; the signed envelope per frame goes.
- Two state shapes: pure `RoomState` for logic, a schema tree for sync, one projector.
- The shell belongs to the framework: lifecycle, matchmaking, transport.
- docs.colyseus.io describes 0.18, not 0.16. This plan targets 0.18.
