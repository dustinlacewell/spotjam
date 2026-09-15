Status: not built — proposal.

# Per-member topics

## Public playlists: on the schema, scoped by StateView

Playlists live on `MemberSchema.playlists`, tagged `.view(TAG_PLAYLISTS)`. Request/reply
is what we have today and it goes stale: the viewer learns of an edit only when a
counter tells it to ask again. `room-state.md` shows the view calls.

`messages["set-public-playlists"]` keeps `validate(sharedPlaylistsZod, fn)` →
`Room.setPublicPlaylists`, `projectState`; the projector patches the array. The client
sends `view-member` when it opens a member page and `unview-member` when it navigates
away. An owner's edit then pushes to every viewer as a delta. No fetch, no counter, no
staleness. This deletes `view-playlists`, the `playlists` event and `playlistsRevision`.

`WebSocketTransport` `maxPayload` defaults to 4 KB. Set it to 1 MB and cap the op in
`validate`.

## Reactions: broadcast, not state

Not the StateView pattern. A reaction is an ephemeral event, not state: it has no
current value a late joiner should read. On the schema it would mean writing a field
then clearing it.

`messages["react"]`: validate `{ emoji }` against an allowlist, rate-limit via
`client.userData.lastReactAt`, then `this.broadcast("reaction", { pubkey, emoji, at })`.
Nothing touches `RoomState` or the schema.

## Avatars: a plain member field

State, so it goes on the schema — but not `.view()`: every member sees every avatar, so
there is nothing to scope. `MemberSchema.avatar: t.string()`, set in `onJoin` from
`IdentityRecord.avatar` (new column) or by `messages["set-avatar"]`.

## Not a separate room

A room per member or per topic doubles join, auth and reconnect work. Not needed.
