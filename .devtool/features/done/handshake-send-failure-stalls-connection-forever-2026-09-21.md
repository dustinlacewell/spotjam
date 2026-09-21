---
id: "handshake-send-failure-stalls-connection-forever-2026-09-21"
status: "done"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T21:52:59.968Z"
completedAt: "2026-09-21T21:52:59.968Z"
labels: ["created-by-ai", "sync", "bug"]
order: "a14"
---
# Handshake send failure with a live socket stalls the connection forever

`#onOpen` does `void this.#send(helloPayload(), generation)` and
`#advanceHandshake` does `void this.#send(registerPayload(...), generation)`
(apps/desktop/src/lib/connection.ts:161,188,253-281). `#send` returns
`false` when the Rust signer throws (identity command unavailable) or
the socket closes during the async `seal` — but in the seal-failure
case `onclose` never fires, so nothing schedules a reconnect. The
socket stays open, `#handshake` is stuck in `"greeting"`/`"registering"`,
`isReady()` is permanently false.

Failure mode: the UI shows a connected-but-dead session
(`connected`, `synced:false`) indefinitely; every `RoomClient` op is
silently dropped (`send()` bails when not ready) and no `onReady` ever
fires. Same stall applies to the registration leg if signing fails
while the socket is alive.

Fix: treat a failed handshake send like a socket failure — close the
socket (or schedule a reconnect) when `#send` returns false during the
handshake.