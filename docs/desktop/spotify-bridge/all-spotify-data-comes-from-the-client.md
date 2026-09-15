# All Spotify data comes from the signed-in client

Every piece of Spotify data the desktop app needs goes through the local
Spotify client over the Chrome DevTools Protocol. Playback state, playback
control, playlist contents, track titles, artists, cover art: all of it.

No code path fetches from open.spotify.com, the oembed endpoint, or
api.spotify.com. Not as a primary source, and not as a fallback.

## Why

- The public endpoints are unauthenticated and rate limited per IP. One
  busy session got every request answered with 429, and every track on
  screen turned into its bare id.
- The Web API with the client's token is throttled per token the same
  way, and the client's own traffic shares that quota.
- The client is already signed in and already holds this data. It caches
  it, it is the source every list on its own screen draws from, and it
  keeps working offline for anything already seen.

## How

xpui registers its services in a registry that React exposes through a
context. The injected scripts resolve a service by `Symbol.for(name)` and
call it. See `service-registry-keys.md` for the lookup and
`track-metadata.md` for the metadata service.

When a new kind of data is needed, find the xpui service that serves it,
call that. Do not reach for an HTTP endpoint.
