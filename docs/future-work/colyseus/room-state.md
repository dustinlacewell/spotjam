Status: not built — proposal.

# Room state: pure core plus a synced schema

## What stays pure

`apps/server/src/room-state.ts` and `handle-op.ts` stay file-for-file, tests included.
`buildSessionQueue` and `listParticipants` become exported for the projector.
`projectSnapshot` and `RoomSnapshot` are deleted in the last migration step.

## The schema

New file `apps/server/src/jam-schema.ts`, `@colyseus/schema` 0.18 builder API:

```ts
const QueueItemSchema = schema({ id: t.string(), uri: t.string(), trackId: t.string() }, "QueueItem");
const SessionEntrySchema = schema({ item: QueueItemSchema, ownerPubkey: t.string(), ownerName: t.string() }, "SessionEntry");
const ProgressSchema = schema({ itemId: t.string(), positionMs: t.number(), durationMs: t.number(), sampledAtEpochMs: t.number() }, "Progress");
const PointerSchema = schema({
  itemId: t.string().optional(), ownerPubkey: t.string().optional(), uri: t.string().optional(),
  startedAtEpochMs: t.number(), isPaused: t.boolean(), pausedAtOffsetMs: t.number(),
}, "Pointer");
const PlaylistSchema = schema({ id: t.string(), name: t.string(), trackUris: t.array(t.string()) }, "Playlist");
const MemberSchema = schema({
  pubkey: t.string(), username: t.string(), broadcasting: t.boolean(), avatar: t.string(),
  queue: t.array(QueueItemSchema).view(TAG_QUEUE),        // owner only
  playlists: t.array(PlaylistSchema).view(TAG_PLAYLISTS), // viewers of this member
}, "Member");
const JamState = schema({
  roomCode: t.string(),
  members: t.map(MemberSchema),                    // keyed by pubkey
  order: t.array(t.string()),                      // turn order
  sessionQueue: t.array(SessionEntrySchema),       // server-derived, as today
  pointer: PointerSchema,
  progress: ProgressSchema.optional(),
  serverTime: t.number(),
}, "JamState");
```

`TAG_QUEUE` and `TAG_PLAYLISTS` are numeric tags: one per field, so a view can hold a
member for its playlists without leaking its queue. `turnCursor`, `createdAtEpochMs` and
per-member `progress` stay on `RoomState` only. `sessionQueue` stays server-derived.

## Derivation: a projector, not a replacement

New file `apps/server/src/project-state.ts`:

```ts
export function projectState(state: RoomState, into: JamState, now: number): void
```

It assigns `RoomState` onto the schema. Equal assignments encode nothing, so the wire
delta is what the op changed. Members gone from `state.members` are deleted; new ones
constructed. Arrays are diffed by id and patched with `splice`/`push`/`move`, never
rebuilt. Test: projected tree equals expected JSON; projecting twice encodes zero bytes.

Every handler in `JamRoom` is the same three lines:

```ts
const outcome = handleOp(this.core, pubkey, op, { now, rng });
this.core = outcome.state;
projectState(this.core, this.state, now);
```

Rejected: mutating the schema in handlers. It moves round-robin and exhaustion into a
class that needs a room to test.

## Per-client visibility via StateView

Every client gets a view in `onJoin`, after the first `projectState`. Playlists use the
same mechanism, driven by the page the client is on:

```ts
client.view = new StateView();
client.view.add(members.get(pubkey), TAG_QUEUE);                       // own queue
"view-member":   (c, { pubkey }) => c.view.add(members.get(pubkey), TAG_PLAYLISTS),
"unview-member": (c, { pubkey }) => c.view.remove(members.get(pubkey), TAG_PLAYLISTS),
```

`view.add` is one-shot: it grants the instance, then the encoder sends deltas. So an
owner's edit reaches every current viewer with no fetch and no revision counter. Two
connections with one key add the same instance. A leaving member is deleted from the
map, so that needs no `view.remove`. Payload cost: `view.add` sends the whole playlist
set once, deltas after. See `risks.md`.

Turn order, pointer, progress keep their meaning. A progress tick changes two numbers
and costs a few bytes per client instead of a snapshot.
