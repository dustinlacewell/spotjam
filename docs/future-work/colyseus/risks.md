Status: not built — proposal.

# Risks

- **Version.** The docs describe 0.18. `onDrop`, `onReconnect`, the `messages` map,
  `validate`, `room.request`, and `@colyseus/sdk` are 0.17/0.18. Pin 0.18. Do not mix
  the 0.16 `@filter` decorator with `StateView`.

- **Tauri WebView.** The SDK uses browser `WebSocket` and `fetch`; WebView2 and
  WKWebView have both. Matchmake is an HTTP `POST` before the socket opens, so the Tauri
  CSP `connect-src` must allow `https://` and `wss://` on the server host.

- **`maxPayload` 4 KB default.** `set-public-playlists` and a big `enqueue` exceed it
  and the socket closes silently. Set it explicitly; cap size in `validate`.

- **Reconnect token is not user-signed.** Anyone holding `room.reconnectionToken`
  inside the `allowReconnection` window resumes the seat. Keep the window at 30 s,
  never log the token. A failed reconnect falls back to a fresh signed join.

- **Reconnect delivers a full state.** The SDK reconciles it into the held tree;
  `viewFromState` reads the whole tree, so this is transparent. Re-test under `listen`.

- **Playlists in a StateView cost a full set per view.** `view.add` encodes the whole
  array to that client; only later edits are deltas. Always `unview-member` on
  navigation. The docs warn StateView is not built for large data: cap playlist count
  and tracks per playlist in `validate`.

- **Two connections, one key.** `onLeave` must check `this.clients` for another client
  with the same `client.auth.pubkey` before `Room.leave`. Test it in step 3.

- **Room code race.** Colyseus mints `roomId`; the code is a `filterBy(["roomCode"])`
  option. Two racing `joinOrCreate` with a new code can make two rooms. Accept, or
  serialise through `matchMaker.query` then `joinById` in a `/join` route.

- **Schema limit.** 63 fields per schema. `JamState` has 7, `MemberSchema` 6.
