# Cover art is a CDN fetch, and that is what the client does

`track_api.rs` turns an image's `file_id` into
`https://i.scdn.co/image/<hex>` and the webview `<img>` loads it from
Spotify's image CDN. **This is correct.** It is not a violation of
[all-spotify-data-comes-from-the-client.md](all-spotify-data-comes-from-the-client.md),
and it must not be "fixed".

## The evidence

Probed against a live signed-in client on 2026-09-15 (client 1.3.0.277,
Chrome 146) over CDP, reading the client's own DOM and its
`performance.getEntriesByType("resource")`:

- 178 `<img>` elements on screen. 86 had a `src` on `i.scdn.co`.
- Those resource entries carry `initiatorType: "img"` and real bodies —
  28741 bytes for one `ab67616d00001e02…` cover, ~1 KB for the small
  `ab67616d000011eb…` variants. The client fetched them itself.
- Other image hosts the client's own markup uses: `mosaic.scdn.co`,
  `misc.scdn.co`, `pickasso.spotifycdn.com`, `image-cdn-ak.spotifycdn.com`,
  `image-cdn-fa.spotifycdn.com`, `seed-mix-image.spotifycdn.com`,
  `lexicon-assets.spotifycdn.com`, `blend-playlist-covers.spotifycdn.com`,
  `daylist.spotifycdn.com`, and `encore.scdn.co` for fonts.

There is no internal image-bytes service to find. The metadata service
hands out a `file_id`; the CDN is how every Spotify surface turns that
id into pixels.

## Why this does not contradict the rule

The rule exists because **metadata** endpoints are rate limited per IP
and per token, and one busy session was enough to get 429 on every
request and turn every track on screen into its bare id. That is a
throttled lookup API.

`i.scdn.co` is a content-addressed image CDN. The path is a hash of the
bytes, the response is immutable and cacheable forever, and the client
itself leans on it for every cover it draws. Fetching a cover from it is
not the failure mode the rule guards against.

The rule still binds for everything it names: `api.spotify.com`,
`open.spotify.com`, the oembed endpoint. Titles, artists, playlist
contents and playback state come from the client's JS modules over CDP,
always.

## Image id variants

The `file_id` prefix encodes the size. Seen on screen:

- `ab67616d000011eb…` — small, ~1 KB
- `ab67616d00001e02…` — medium, ~29 KB
- `ab67616d0000b273…` — large (what `widest_cover` picks)

The same album art appears under all three ids. A cache keyed on the
`file_id` therefore dedupes across every track of an album at a given
size, but treats sizes as separate entries — which is right, they are
different bytes.

## URIs the client resolves internally

Not every client `<img>` src is an HTTP URL. These appeared too:

- `spotify:image:<file_id>`
- `spotify:mosaic:<id>:<id>:<id>…` — the multi-cover playlist collage

The client resolves these itself. We do not need them today: the
metadata service gives us a plain `file_id` per track. If a playlist
collage is ever wanted, this is the thread to pull.

## Reproducing this probe

Spotify must be running with the debug port open —
`Spotify.exe --remote-debugging-port=9222`, which is what
`launcher.rs` does. Then evaluate against the `type: "page"` target from
`http://127.0.0.1:9222/json`: read `document.querySelectorAll("img")`
srcs and `performance.getEntriesByType("resource")`, and bucket both by
URL host.
