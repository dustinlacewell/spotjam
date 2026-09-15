Status: not built — proposal.

# Identity and auth under Colyseus

## Decision: the key signs a join token, not every message

Today every frame is an `Envelope` opened by `Session#verify` and de-duplicated by
`ReplayGuard`. Under Colyseus, messages ride a session the server already identified.
Signing each one would re-wrap every payload and cost a Tauri `identity_sign` round trip
per drag. So the key signs once, at join. After that the Colyseus session is the identity.

## The join token

New file `packages/protocol/src/join-token.ts`:

```ts
interface JoinClaim { roomCode: string; nonce: string; timestamp: number }
type JoinToken = Envelope<JoinClaim>;   // seal/open unchanged
```

`roomCode` binds the token to one room. The desktop calls `IdentityClient.seal(claim,
pubkey)`, sets `client.auth.token = JSON.stringify(token)`, then
`client.joinOrCreate("jam", { roomCode })`. The SDK sends the token as the
`Authorization` header of the matchmake request.

## Where the checks go

`apps/server/src/jam-room.ts`, `static async onAuth(token, options, context)`. It runs at
matchmake time and short-circuits the instance `onAuth`. Steps:

1. `open(JSON.parse(token), now)` — signature and clock window.
2. `replay.admit(nonce, now)` — `ReplayGuard` unchanged; now one nonce per join.
3. `claim.roomCode === options.roomCode`.
4. `identities.lookupByPubkey(pubkey)` — null rejects.

Reject with `ServerError` carrying the existing `ErrorEvent["code"]`. Return
`{ pubkey, username }`; it becomes `client.auth` in `onJoin`. The pure decision lives in
`apps/server/src/join-auth.ts` as `decideJoin(token, options, now, lookup)`.

## Registration

`register` stays a signed envelope and moves to `POST /register`, a route on
`defineServer`. Handler: `open`, `replay.admit`, `identities.register`. Reply:
`RegisteredEvent` or `ErrorEvent`. `hello` is deleted: a join with a registered key is
the hello. Onboarding order: create key → `POST /register` → join.
`Connection#advanceHandshake` and its state machine go with it.

## The identity store

Unchanged: `IdentityStore`, `decideRegistration`, `MemoryIdentityStore`,
`SqliteIdentityStore`. `@colyseus/auth` is not used; it owns users, JWTs and OAuth, none
of which fit a self-issued key. We take only the `client.auth.token` transport and the
static `onAuth` hook.

## Reconnect

`room.reconnectionToken` is Colyseus's, per connection, not user-signed. It only resumes
a seat a signed join opened and expires with `allowReconnection(client, 30)`. See `risks.md`.
