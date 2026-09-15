# Linked playlists

A linked playlist is a local playlist whose content comes from a Spotify
playlist. Spotify owns the content. Spotjam reads it and does not edit it. You
edit it in Spotify and sync.

## Making one

**Link playlist**, under the playlist list, opens a dialog that takes a pasted
or dropped playlist link and links it.

**Dropping a playlist link on the list** asks first: copy or link. A copy takes
the tracks and forgets where they came from — an ordinary editable playlist. A
link keeps the tie. Only the user knows which one a drop meant, so spotjam does
not guess.

A playlist link dropped on a **queue** still just queues its tracks. Nothing is
stored, so there is nothing to link and nothing to ask.

## The source

`Playlist.source` is `{kind:"local"}` or
`{kind:"spotify", playlistId, syncedAt}`. It is install-local state, kept in
the existing `spotjam.playlists` localStorage.

It does not go on the wire. `toSharedPlaylists` projects to `{id, name,
tracks}`, so a peer sees a linked playlist as an ordinary one, and a peer
copying tracks out gets a plain local playlist.

A stored source is honoured only when it is a well-formed link. Anything else
loads as local — a playlist that claimed a link it does not have would be
syncable, and a sync can drop it.

## What a link takes away

`isEditable` is false for a linked playlist, and the UI reads that one
predicate:

- No rename. A sync overwrites the name.
- No per-track remove, no drop-to-insert.
- **No shuffle.** It rewrites the stored order, which the next sync throws
  away.
- Delete stays. Unlinking or deleting is how you get rid of one.
- "Add to queue" and "Replace queue" stay. They copy tracks out rather than
  changing the playlist.

Unlinking keeps the tracks the playlist holds right now and makes it an
ordinary local playlist.

## Adding tracks

The one edit a linked playlist does take is an add, from the track context
menu — because it does not edit the local copy at all. The tracks are
appended to the **Spotify playlist**, and the playlist then syncs to pick them
up. A local insert would only survive until the next sync.

`canAddTracks` decides whether the playlist appears in that menu:

- A local playlist always takes tracks.
- A linked one takes them only when Spotify says we may write.

A link can point at anyone's playlist, and only its owner may write to one.
So a linked playlist you do not own is simply absent from "add to playlist" —
there is no failure to report, because the action is never offered.

Permission is stored on the source as `canAdd` and restated by every sync:
access can open up or be withdrawn. A link stored before permission was
tracked loads as not addable until its first sync.

## Sync

Opening a linked playlist syncs it, and a Sync button in its header does the
same on demand. The fetch is a local CDP call to the running client — no
network, no rate limit — so opening is a cheap moment to refresh.

`reconcileLinked` replaces name and tracks wholesale and stamps `syncedAt`.
Wholesale is the point: a track removed in Spotify is removed here, and the
order is theirs. It ignores local playlists and unknown ids, which is what
makes a sync landing after an unlink or a delete harmless.

One fetch per playlist at a time. The hook ignores a second call while one is
in flight.

Replacing tracks cannot corrupt anyone's queue: queue items are minted
per-add with their own ids.

## The two failure kinds

Auto-drop keys on "Spotify says this playlist is gone" and never on "spotjam
could not reach Spotify". See
[../desktop/spotify-bridge/playlist-fetch-failures.md](../desktop/spotify-bridge/playlist-fetch-failures.md)
for how the split is made and why anything ambiguous is unreachable.

An unreachable sync leaves the playlist untouched and shows "Can't connect to
Spotify" with a Sync button in place of the track list. That is scoped to the
pane, not an app-wide banner. An empty track list would read as "Spotify
emptied this playlist", which is the one thing an unreachable client does not
tell us.

## Not built

There is no way to list the user's playlists. No rootlist or library service
is resolved. `getList`/`getListContents` reject every rootlist URI tried
(`spotify:user:@:rootlist`, `spotify:user:rootlist`, `spotify:rootlist`,
`spotify:internal:rootlist`) with `Invalid list response!`. Linking starts
from a pasted or dropped link. A "pick from your playlists" browser needs a
new service discovered first.

Removing a track from a linked playlist, and reordering one, are not built.
`_playlistAPI.remove` and `.move` exist and key on row `uid`s, which
`fetch_playlist` currently discards.

`fetch_playlist` drops non-track entries (local files, episodes), so a linked
playlist can differ from what Spotify shows.
