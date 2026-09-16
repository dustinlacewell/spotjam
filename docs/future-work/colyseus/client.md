Status: not built — proposal.

# The client side

## `packages/room/src/ports/room.ts` — the seam that does not move

`Room` stays. `QueueView.tsx` and everything below it compile without edit. Two changes:
`viewPlaylists(pubkey)` becomes `viewMember(pubkey)` / `unviewMember(pubkey)`, both
`void` — they send a message and the playlists arrive as state. And
`ConnectionStatus.socket` gains `"reconnecting"`, from `onDrop`/`onReconnect`.

## `packages/room/src/lib/room-client.ts` — what the pure core keeps

Keeps `ConnectionStatus`, `RoomView`, `RoomError`, `describeError`, `toQueueItems`, and
every getter (`participantsOf` … `usernameOf`).

`ops` becomes `messages`: same builders, no `roomId`, returning `[type, payload]` for
`room.send`. `joinRoom`/`leaveRoom` go; the SDK owns join and leave.

`reduce` and `parseServerEvent` are replaced by one pure function:

```ts
export function viewFromState(state: JamStatePlain, me: PublicKeyHex): RoomView
```

It takes the decoded tree as plain data (`state.toJSON()`) and fills the fields the
getters read. A viewed member's `playlists` are in that tree, so `playlistsOf` reads
state like every other getter. The shell calls it on every `onStateChange`. Per-field
`listen` is a later optimisation. Deleted: `helloPayload`, `registerPayload`,
`backoffMs`, `isServerEvent`.

## `apps/desktop/src/lib/connection.ts` — replaced by the SDK

Deleted. `apps/desktop/src/lib/colyseus-client.ts` builds one `@colyseus/sdk` `Client`
per identity and exposes `joinJam(roomCode)`: seal the `JoinClaim`, set
`client.auth.token`, `client.joinOrCreate<JamState>("jam", { roomCode })`. Registration
is `client.http.post("/register", sealedEnvelope)` during onboarding.

## `apps/desktop/src/lib/room.ts` — `RoomClient` over an SDK room

Same name, same `implements Room`. Constructor takes the SDK `Room<JamState>`. It
subscribes to `onStateChange`, `onDrop`, `onReconnect`, `onLeave` and `onError`. Each
mutator is `room.send(...messages.x(...))`. `destroy()` is `room.leave(true)`, and it
sends `unview-member` first if one is held.

Room browser: `BrowseRooms` joins `LobbyRoom` and folds `"rooms"`, `"+"`, `"-"` into
`RoomSummary[]`. `roomCode`, listener count and `trackUri` ride in `metadata` via
`setMetadata`. The `watch-room` peek goes: state reaches a client only through a join,
so the browser joins to preview and leaves on back.

## The mock room

`packages/room/src/mock/mock-room.ts` does not change; the port does not move, so the
site keeps rendering with no server. `viewMember` and `unviewMember` set and clear the
member whose playlists the mock view exposes.
