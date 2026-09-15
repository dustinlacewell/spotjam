Status: not built — proposal.

# Migration steps

Each step lands green on `pnpm -r exec tsc --noEmit` and every package's tests. Target
Colyseus 0.18, `@colyseus/schema`, `@colyseus/sdk`, `@colyseus/testing`.

## Seams that do not change

`packages/room/src/ports/room.ts`; `apps/server/src/{room-state,handle-op,ports,
identity-store,sqlite-identity-store,replay-guard}.ts`;
`packages/protocol/src/{identity,canonical,envelope,registration}.ts`;
`apps/desktop/src-tauri/src/identity.rs`; `apps/desktop/src/lib/identity.ts`;
`packages/room/src/mock/mock-room.ts`.

## Seams that change

Wire: signed envelope per frame → signed join token + Colyseus messages. Server shell:
`Session` + `connections.ts` + `rooms.ts` → `JamRoom` + `LobbyRoom`. Client shell:
`Connection` → SDK `Client`. `RoomView` source: folded events → `viewFromState`.
`ops.*(roomId, …)` → `messages.*(…)`.

## Steps

1. **Schema and projector.** Add `jam-schema.ts`, `project-state.ts`. Tests: projected
   tree equals expected JSON; second projection encodes zero bytes; `leave` deletes the
   map entry; `move` yields an array `move`, not a rebuild. Deletes nothing.

2. **Join token.** Add `packages/protocol/src/join-token.ts`, `apps/server/src/join-auth.ts`.
   Tests: `decideJoin` accepts a good token; rejects bad signature, stale clock, replayed
   nonce, wrong `roomCode`, unknown key, each with its `ErrorEvent["code"]`.

3. **`JamRoom` on a second port.** Add `jam-room.ts` (static `onAuth`; `onJoin` with
   `StateView`; `messages` with `validate`; `onDrop` → `allowReconnection(client, 30)`;
   `onLeave` → `Room.leave` unless another client holds the pubkey; `setMetadata` per
   commit) and `app.config.ts` (`defineServer`, `WebSocketTransport({ server, maxPayload })`,
   `/register`, `/health`, `LobbyRoom`, `.enableRealtimeListing()`). `main.ts` starts
   both servers. `@colyseus/testing` tests: two signed joins; enqueue + broadcast starts
   playback; owner sees `queue`, peer does not; drop + `client.reconnect` keeps the
   member; `view-member` reveals playlists to the asker only and an owner edit reaches
   the viewer as a delta; `unview-member` stops it; lobby `"+"` fires on join.

4. **Client core.** Add `messages`, `viewFromState` to `room-client.ts`; keep `reduce`.
   Share zod schemas in `packages/protocol/src/messages.ts`. Tests: `viewFromState`
   matches today's getters; every builder passes the server's `validate`.

5. **Desktop on Colyseus.** Add `colyseus-client.ts`; rewrite `room.ts` over the SDK
   room; registration to `POST /register`; `BrowseRooms` on `LobbyRoom`. `room.test.ts`
   rewritten against a fake SDK room. Deletes `connection.ts`, `connection.test.ts`,
   `use-live-rooms.ts`. Deploy the server with both listeners; ship the desktop.

6. **Cut the old server.** Delete `session.ts`, `connections.ts`, `rooms.ts`,
   `room-summary.ts`, `server.ts`, `interop.test.ts` and their tests. Delete
   `projectSnapshot`, `RoomSnapshot`, `RoomStateEvent`, `RoomDetailEvent`,
   `RoomListEvent`, `PlaylistsEvent`, `ViewPlaylistsOp`, `queries.ts`, `JoinRoomOp`, `LeaveRoomOp`,
   `HelloPayload`, `reduce`, `parseServerEvent`, `isServerEvent`, `helloPayload`,
   `registerPayload`, `backoffMs`. `ErrorEvent` and `RegisteredEvent` stay for `/register`.

7. **Topics.** Reactions and avatars per `playlists-and-topics.md`, each with a test.

Steps 1, 2, 4 are independent. 3 waits on 1 and 2. 5 waits on 3 and 4. 6 on a deployed 5.
