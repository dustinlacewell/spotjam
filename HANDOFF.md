# Handoff — room browser work in progress

## Current build state: BROKEN

`pnpm -r exec tsc --noEmit` fails in `apps/desktop`. `BrowseRooms.tsx`'s
`MOCK_ROOMS` array is missing the new `createdAtEpochMs` field on
`RoomSummary` (5 errors, all in that one array literal). This is the very
next fix needed — see "Immediate next step" below.

Server (`apps/server`) and protocol (`packages/protocol`) typecheck and test
clean. Desktop tests were last green before the `createdAtEpochMs` addition
(not re-run since).

## What this session built

A room browser: a screen listing live rooms on the server, reachable from the
join screen and from inside a room, so a user can discover and hop between
rooms instead of only typing a room code.

### Architecture split (done, tested, working)

The desktop app's socket handling was one fused class (`RoomClient` in
`lib/room.ts`) that owned the WebSocket, reconnect backoff, the hello/register
handshake, AND one room's membership all at once. A room browser needs a
live, authenticated connection *before* any room is picked, which that shape
couldn't do. This was split:

- **`apps/desktop/src/lib/connection.ts`** (new) — `Connection` class. Owns
  the socket, reconnect backoff, and handshake for the app's whole lifetime,
  independent of any room. Public surface: `send(op | query)`, `onEvent()`,
  `onReady()` (fires on first connect AND every reconnect), `onStatus()`,
  `isReady()`, `listRooms()`, `destroy()`.
- **`apps/desktop/src/lib/room.ts`** — `RoomClient` rebuilt to take an
  existing `Connection` + `roomId` in its constructor instead of owning a
  socket itself. Re-joins automatically via `connection.onReady()` after a
  reconnect. Its own `destroy()` no longer closes the socket (not its
  connection to close) — it just sends `leave-room` and unsubscribes.
- **`apps/desktop/src/App.tsx`** — builds one `Connection` per identity,
  before any room is chosen. `JoinRoom` and `BrowseRooms` both receive it.
  On join, `new Room(connection, roomId)` is built on top of the shared
  connection.

Tests: `lib/room.test.ts` harness rewritten to build a `Connection` then a
`RoomClient(connection, roomId)`. `lib/connection.test.ts` (new) covers query
gating before handshake completes, `room-list` event delivery, and
`onReady` re-firing after reconnect. All passing as of the split (188 desktop
tests green before today's `createdAtEpochMs` change, not re-verified since).

**Real bug this caught and fixed:** `Connection.send()` had no guard against
sending before the handshake completed. Fixed: it now silently no-ops until
`isReady()`, relying on callers to re-issue from `onReady()`.

### Protocol / server: `list-rooms` query (done, tested)

Ops require a `roomId` and room membership; a room-list request needs
neither. Added a third payload class alongside `Op` and `AuthPayload`:

- **`packages/protocol/src/queries.ts`** (new) — `Query` type,
  `ListRoomsQuery`, `isQuery()` guard.
- **`packages/protocol/src/events.ts`** — `RoomSummary` (`roomId`,
  `listeners`, `trackUri: string | null`, `createdAtEpochMs: number`) and
  `RoomListEvent` (`{ type: "room-list", rooms: RoomSummary[] }`), added to
  `ServerEvent`.
- **`apps/server/src/rooms.ts`** — `RoomRegistry.summaries(): RoomSummary[]`,
  a pure read over live rooms only (a deserted room is deleted from the
  registry the moment its last member leaves, so nothing needs filtering).
  `get(roomId, now?)` now takes an optional clock reading, threaded to
  `emptyRoom` only when it actually constructs a fresh room (an existing
  room's `createdAtEpochMs` is never touched by `get`).
- **`apps/server/src/room-state.ts`** — `RoomState.createdAtEpochMs: number`,
  stamped once in `emptyRoom(roomId, now)`.
- **`apps/server/src/session.ts`** — `receive()` gained a third branch
  (`isQuery(payload)`) alongside auth/op handling. `#handleQuery` requires
  `connection.pubkey !== null` (authenticated) but no room membership.
  `#joinRoom` now passes `clock.now()` into `rooms.get()` so a freshly
  created room gets a real timestamp.
- Tests: `session.test.ts` has a `describe("queries", ...)` block — auth
  gating, empty list, listener count + current track (via a real
  enqueue→broadcast→skip sequence to actually fill the pointer), and that a
  vacated room disappears. All passing.

**Deployed:** the live server behind `wss://yjs.ldlework.com` (Docker Compose
project `spotjam`, `docker compose -p spotjam` in `apps/server/`) was rebuilt
and restarted with the `list-rooms` support mid-session. It does NOT yet have
today's `createdAtEpochMs` addition — that landed after the last deploy.
**Redeploy before testing uptime display against the live server.**

One deploy gotcha hit and worked around: the server's Docker build runs
`pnpm install --frozen-lockfile` against the *whole* monorepo lockfile before
filtering to the server's deps, so an unrelated desktop-only dependency
(`lucide-react`, added this session for icon buttons) tripped a supply-chain
minimum-release-age policy. Fixed by pinning `lucide-react` to `1.45.0`
(already-aged) instead of `1.46.0` (published day-of). If this happens again
with some other fresh dependency, same fix: pin to the previous release.

### Desktop UI: BrowseRooms screen (in progress, currently broken)

- **`apps/desktop/src/components/BrowseRooms.tsx`** (new) + matching
  `.module.css` — a full-page view (header bar + body, matching
  `QueueView`'s actual page shape, not a floating modal) listing live rooms:
  room id, now-playing track (art + title + artist via the existing
  `useTrackMetadata` hook — same pattern as `QueueItemCard`), listener count.
  Has a "+ New room" inline form in the body (expands to a text input +
  Create button) and a "← Back" button in the header.
- **`apps/desktop/src/components/use-live-rooms.ts`** (new) — extracted
  `useLiveRooms(connection)` hook: sends `listRooms()` once ready and again
  on every reconnect, updates from `room-list` events. Shared by `JoinRoom`
  and `BrowseRooms`.
- **`apps/desktop/src/components/JoinRoom.tsx`** — gained a "Browse rooms"
  button and a live "N public rooms" count line, both using
  `useLiveRooms`.
- **`apps/desktop/src/App.tsx`** — `PreSessionView` state (`"join" |
  "browse"`) toggles between `JoinRoom` and `BrowseRooms` before a session
  exists. `QueueView` gained an `onLeave` prop; leaving a room now returns to
  `BrowseRooms` specifically (not `JoinRoom`), via `handleLeave()`.
- **`apps/desktop/src/components/QueueView.tsx`** — added a "Leave room"
  button in the header's right-hand group, next to `BroadcastToggle`.
- **Mock data**: `BrowseRooms.tsx` has a `MOCK_ROOMS` array (clearly marked
  `// TEMPORARY`) so the populated list is visible without a live server with
  real rooms on it. Falls back to it only when the live list is empty
  (`live.length > 0 ? live : MOCK_ROOMS`). **This is the thing currently
  failing typecheck** — the array literals don't have `createdAtEpochMs` yet.
  Uses real, verified Spotify track IDs (checked against the oembed endpoint
  the app's own metadata fetch uses) — do not swap in made-up IDs, they will
  never resolve and the row will show the bare ID as a fallback.

## Immediate next step

Fix `BrowseRooms.tsx`'s `MOCK_ROOMS` — add a `createdAtEpochMs` to each
entry (stagger them, e.g. `Date.now() - N * 60_000`, so uptime differs
per row once that's rendered). Then re-run:

```
pnpm -r exec tsc --noEmit
pnpm --filter @spotjam/desktop test
pnpm --filter @spotjam/desktop build
```

## What's asked for but NOT built yet

The user asked for three more things on `BrowseRooms`, in the same message
that surfaced the typecheck break:

1. **Show room uptime** ("how long a room has been up"). The data now exists
   server-side (`RoomSummary.createdAtEpochMs`, done) — the UI needs a
   relative-time render (`"12m"`, `"2h"`, etc.) per row. Not yet touched in
   `BrowseRooms.tsx`.

2. **Master-detail layout**: room list on the LEFT, and clicking a room shows
   its **current queue** on the RIGHT, with a **Join button** there (instead
   of, or in addition to, clicking the row itself to join). This is a real
   layout rework of `BrowseRooms.tsx` from the current single full-width list.

3. **Fix a layout-shift bug**: clicking "+ New room" currently nudges the
   whole list down by a few pixels, because the button and the
   input+button form it swaps to have different rendered heights. Needs a
   fixed-height slot for that control (e.g. wrap both states in a
   fixed-height container, or match padding/border exactly between
   `.newRoomButton` and `.newRoomForm`'s children) so swapping between them
   causes zero layout shift.

### The open design question — read before touching #2

Item 2 ("show a room's queue before joining") ran into a real protocol gap:
**there is currently no way to see a room's queue without joining it.**
`RoomState`'s session queue is only ever sent via `projectSnapshot`, which is
only pushed to sockets that are members of that room (`session.ts`'s
`#broadcast()` iterates `connectionsInRoom`). `list-rooms` today only returns
the lightweight `RoomSummary` (id, listener count, current track, created
time) — not the queue.

I asked the user how they wanted to close this gap (bundle the queue into
`list-rooms`'s payload vs. a separate on-demand "peek" query per room). Their
answer went further: they want the room list to be **live-subscribed**, not
snapshot-fetched — i.e., once you're looking at the browser, it should keep
updating in real time as rooms' queues/listener counts/now-playing change,
without polling or a fresh `list-rooms` round trip. They explicitly floated
whether this subscription model should extend across the whole app, not just
the browser.

**This is a real architectural fork, not a UI tweak, and it was not decided
before the session ended.** Both stronger options are genuinely more work
than the "just add data to list-rooms" originally scoped:

- **(a) Bundle queue into `list-rooms`**, keep it one-shot (matches
  everything built so far — snapshot-on-request, re-sent from `onReady`).
  Cheapest, but does NOT give live updates while the browser sits open — a
  room's queue could go stale until the user leaves and re-opens the browser
  or it happens to re-query.
- **(b) A real "watch without joining" subscription**: rooms you're not a
  member of get a lighter-weight live subscription (distinct from full
  membership — `connection.roomId` already means "I'm a member, get full
  ops+broadcasts"; this would be a second, parallel per-connection watch
  list). Needs: a `watch-room`/`unwatch-room` op pair (or turn `list-rooms`
  itself into "subscribe until you send something else"), a new fan-out path
  in `session.ts`'s `#broadcast()` (or a sibling method) that also pushes
  lightweight summary updates to watchers, not just full snapshots to
  members, and the desktop side swapping `useLiveRooms`'s "ask once, refresh
  on reconnect" for "subscribe on mount, unsubscribe on unmount."
- Whether this extends past the room browser to the rest of the app (i.e.,
  do joined-room updates *also* move to this new subscription primitive
  instead of the existing per-member broadcast?) is a bigger call the user
  raised but did not answer. The existing joined-room push-on-every-change
  behavior (via `#broadcast` to `connectionsInRoom`) already works and is
  well-tested — there is no known bug driving a need to touch it. Don't
  assume it needs replacing without the user saying so explicitly.

**Recommendation for whoever picks this up:** don't build (b) speculatively.
Ask the user directly: does "live" mean the browser screen specifically
staying fresh while open (in which case (b), scoped ONLY to the room browser,
is right-sized), or do they actually want to replatform the existing
per-room broadcast mechanism too (much bigger, touches code that isn't
broken)? Get that answered in one message before writing any subscription
plumbing — the two answers lead to very different amounts of code.

## Files touched this session (for `git status` orientation)

Modified: `apps/desktop/package.json` (added `lucide-react@1.45.0`),
`apps/desktop/src/App.tsx`, several `apps/desktop/src/components/*` (styling
tweaks from earlier in the session — wordmark/tagline copy, sidebar
broadcast-dot, playlist toolbar icons — unrelated to the room browser but
part of this session's history), `apps/desktop/src/lib/room-client.ts`,
`apps/desktop/src/lib/room.ts`, `apps/desktop/src/lib/room.test.ts`,
`apps/desktop/src/lib/track-metadata.ts` (empty-string short-circuit),
`apps/server/src/room-state.ts`, `apps/server/src/rooms.ts`,
`apps/server/src/session.ts`, `apps/server/src/session.test.ts`,
`packages/protocol/src/events.ts`, `packages/protocol/src/index.ts`,
`pnpm-lock.yaml`.

New: `apps/desktop/src/components/BrowseRooms.tsx`,
`apps/desktop/src/components/BrowseRooms.module.css`,
`apps/desktop/src/components/use-live-rooms.ts`,
`apps/desktop/src/lib/connection.ts`, `apps/desktop/src/lib/connection.test.ts`,
`packages/protocol/src/queries.ts`.

Nothing has been committed to git this session — everything above is
uncommitted working-tree state.
