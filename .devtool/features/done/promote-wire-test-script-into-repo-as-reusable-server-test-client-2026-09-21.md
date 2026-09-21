---
id: "promote-wire-test-script-into-repo-as-reusable-server-test-client-2026-09-21"
status: "done"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T18:30:00.000Z"
modified: "2026-09-21T22:41:32.121Z"
completedAt: "2026-09-21T22:41:32.121Z"
labels: ["created-by-ai", "devex"]
order: "a10G"
---
# Promote the wire-test script into the repo as a reusable signaling-server test client

The replay-guard live test (replay-guard-expires-nonces-before-future-dated-envelopes-2026-09-21, pre-deploy verification) produced a working thin wire client — 163 lines of Node speaking the real signaling protocol: canonical JSON serialization mirroring `packages/protocol/src/canonical.ts`, ed25519 keypair → 32-byte hex pubkey, envelope construction (nonce/payload/pubkey/timestamp/signature), hello → register → join-room handshake, a `waitFor(pred)` message-match helper, and a pass/fail harness with non-zero exit. Verified 4/4 against a local `apps/server` at HEAD; `WS_URL` selects local (`ws://127.0.0.1:4444`) or deployed (`wss://yjs.ldlework.com`).

Currently it exists only as a kanban attachment (`~/.hermes/kanban/boards/spotjam/attachments/t_7c732139/replay-wire-test.mjs`) — no place for a durable tool.

Task: split into a reusable client module + scenario script(s), e.g. `apps/server/scripts/wire-client.mjs` with `replay-wire-test.mjs` as the first scenario. Deduplicate against `docs/desktop/debugging-the-app.md`, which carries an inline ~60-line recipe for the same thing — point the doc at the script instead so live server testing stops being re-derived per finding.

Related: kanban t_8c03e49b.