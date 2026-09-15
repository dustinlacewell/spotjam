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

## Rows

A playlist holds **rows**, not bare tracks. A `ParsedTrack` says *which
track*; a row says *this occurrence of it, here*:

```ts
interface PlaylistRow { track: ParsedTrack; uid?: string }
```

The uid is Spotify's identity for that row. `remove` and `move` address rows
by uid rather than by track uri, so without it neither is possible. A local
playlist's rows have no uid, and `toSharedPlaylists` never puts one on the
wire.

A playlist still holds each track once. Dropping a track it already has is
skipped, and a sync that finds Spotify holding one twice keeps the first row.

## Editing a linked playlist

Edits to a linked playlist are written to **Spotify**, and the playlist syncs
to pick them up. Nothing is changed locally first: a local edit would only
survive until the next sync.

What that covers: adding tracks (from the track context menu or the add bar),
removing a row, and reordering by drag.

What it does not: **rename**, because Spotify owns the name, and **shuffle**,
which would be one `move` call per row.

Unlinking keeps the tracks and drops the uids — they name rows in a playlist
this one no longer follows.

## Permission

Spotify tracks two permissions separately, and so does the source:

- `canAdd` — may we add tracks. Gates whether the playlist appears in "add to
  playlist" at all.
- `canEditItems` — may we remove and reorder rows. Gates the remove glyph and
  the reorder drag.

A link can point at anyone's playlist, and only its owner may write to one. A
playlist you cannot write to simply does not offer the action — there is no
failure to report, because it is never offered.

Every sync restates both: access can open up or be withdrawn. A link stored
before a permission was tracked loads without it until its first sync.

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

Shuffling a linked playlist is not built: it would be one `move` call per row.

`fetch_playlist` drops non-track entries (local files, episodes), so a linked
playlist can differ from what Spotify shows.
