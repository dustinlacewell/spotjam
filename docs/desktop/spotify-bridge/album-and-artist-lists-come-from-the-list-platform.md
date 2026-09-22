# Album and artist track lists come from the list platform service

The playlist path resolves playlists through `ListPlatformAPI._playlistAPI`
(`playlist_api.rs` → `getPlaylist`). Album and artist links do **not** need a
different registry service: `ListPlatformAPI` itself serves every static
track list through `getList(uri)` / `getListContents(uri)`.

## Verified against the signed-in client (2026-09-21, client 1.2.95.453)

- `getListContents("spotify:album:ID")` returns the album's tracks in album
  order. The list's `formatListData.type` is `"album"`.
- `getListContents("spotify:artist:ID")` returns the artist's tracks in
  Spotify's own ordering; the list type is
  `popular-release-segments-main-roles`, and its attributes carry
  `total_number_of_tracks`.
- One call returns the whole list. The response echoes
  `{ data, totalLength, offset: 0, limit: 0 }` — `limit` 0 means no paging
  was applied, the same "everything in one call" shape `getPlaylist` has.
- Rows are bare references: `{ uri, uid, addedBy, addedAt }` — no track
  names and no durations. Names/durations come from the metadata lookup the
  enqueue path already runs.
- A list that does not exist rejects with exactly
  `Invalid list response!` — the discriminator `list_api.rs` matches on,
  the counterpart of the playlist service's
  `Invalid playlist or members response!`.

## Do not add an AlbumAPI/ArtistAPI

The bundle registers 94 services under `Symbol.for`; none is an album or
artist API (`AlbumAPI`, `ArtistAPI`, `AlbumContentsAPI` … do not exist). The
"list platform" model is Spotify's own: an album and an artist top-tracks
list are lists, like a playlist. If album or artist resolution ever breaks
after a client update, re-verify the shapes above by resolving
`ListPlatformAPI` in the live client — do not go looking for a new service.

Enumerating what the live registry holds (when a name stops resolving):

```js
// inside the page, with a resolved registry context in hand
registry._map.forEach((value, key) => console.log(String(key)));
```