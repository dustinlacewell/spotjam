# Driving the server with the wire-script client

How to join a room and send ops from a script, instead of re-deriving the
wire protocol by hand each time.

## The scripts

Use the committed script client in `apps/server/scripts/`:

- `apps/server/scripts/wire-client.mjs` — the thin reusable client. It
  imports envelope sealing, canonicalization and identity straight from
  `@spotjam/protocol` (so it cannot drift from the wire contract) and
  exports `makeIdentity`, `makeEnvelope`, `createWireClient` (connect,
  `send`, `sendRaw` for pre-built/replayed frames, `waitFor(pred, label)`,
  `handshake({ roomId })`, `close`), plus `createChecks`, a small
  pass/fail step harness.
- `apps/server/scripts/replay-wire-test.mjs` — a worked scenario using the
  client: the replay-guard live test (future-dated envelope accepted,
  byte-identical replay inside the nonce-hold window rejected, replay
  after the window rejected). Read it as a template for driving the room
  from a script.
- `apps/server/scripts/wss-check.mjs` — deployed-server smoke check that
  walks register → join → broadcast → play → position round-trip.

Run any of them from `apps/server` (`WS_URL` overrides the target;
`ws://127.0.0.1:4444` for the local dev server, `wss://yjs.ldlework.com`
for the deployment):

    node --experimental-strip-types --import ./src/register-hook.ts \
      scripts/replay-wire-test.mjs

The resolve hook is needed because `@spotjam/protocol` exports TS sources.

## The protocol shape

Matches `packages/protocol`. Every frame is an envelope `{ nonce, payload,
pubkey, timestamp, signature }` with `signature` = ed25519 over the
canonical bytes of `{ nonce, payload, pubkey, timestamp }`; pubkey hex is
the identity. Handshake is `hello` → (`error unknown-identity` →
`register`) → `registered`. Ops include `join-room`, `set-broadcasting`,
`enqueue` (`items: [{ id, uri, trackId, durationMs }]`), `set-paused`,
`seek`, `skip`. Server events include `room-state`, which carries the full
snapshot (participants, sessionQueue, myQueue, pointer). The client
distinguishes `sessionQueue` (the broadcaster's play queue) from `myQueue`
per peer — a non-broadcaster's `enqueue` lands in `myQueue`.

## Two peers in one room

Two concurrent script peers joining the same room each get their own
post-join `room-state` snapshot. Confirm with two long-lived peers before
relying on cross-peer snapshot sync from scripts — a short-lived script
peer may not see another peer's join arrive.

## What this does not cover

- Real network paths: loopback behaves differently from TLS, NAT
  traversal, and latency between machines.
- A script-driven `PlayerAPI` call acts on the Spotify client outside the
  bridge. The bridge and the room see the resulting state change through
  their observer, but the command itself is not a room command.
