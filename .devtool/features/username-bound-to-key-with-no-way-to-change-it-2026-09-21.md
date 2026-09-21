---
id: "username-bound-to-key-with-no-way-to-change-it-2026-09-21"
status: "todo"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T02:00:00.000Z"
modified: "2026-09-21T05:37:40.705Z"
completedAt: null
labels: ["identity"]
order: "a3"
---
# Username is bound to the key, can never change, and registration failures never surface

Two connected problems around identity:

## 1. Registration failures never surface in the UI
`username-taken` (and every other registration refusal) is mapped to a
human-readable message (`humanMessageFor`,
packages/room/src/lib/room-client.ts) and stored via `lastError()` —
but nothing in the join/key-creation UI renders it. A user whose name
is taken just... doesn't join; the only trace is the console. There is
no feedback when joining and none at identity creation.

## 2. The username is permanently bound to the key
Identity binds pubkey → username durably
(`apps/server/src/identity-store.ts`). Same-name re-register is a
reconnect no-op, but there is no rename operation: wanting a different
name requires minting a new key, orphaning the old record.

## Design space (needs a ratified decision before implementation)
The key already identifies the peer for auth, so options:
a. **Unbind display names from the key** — display name becomes
   free/editable metadata; auth identity stays the key. Collisions
   resolved by showing a short discriminator derived from the pubkey
   when two peers pick the same name. This dissolves both the rename
   problem and most of the "taken" class (names stop being scarce).
b. **Keep binding + allow same-key rename** — register-with-new-name
   replaces the name the key owns; freed name reusable; needs a rename
   event or snapshot sync and possibly a rename rate-limit.
c. **Keep binding as-is** + pubkey discriminator as a suffix — names
   stay scarce but uniqueness is display-level; least protocol change.
Whichever is chosen: registration refusals must surface in the join UI
(Problem 1 is a bug regardless of the model chosen).

Recommendation direction: (a) — unbind the display name; it removes
scarcity, makes rename trivial, and reduces the failure surface to
"pick another name or accept a discriminator". User ratifies the model
before any implementation.