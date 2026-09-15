# spotjam

## ⚠️ ALL SPOTIFY DATA COMES FROM THE SIGNED-IN CLIENT OVER CDP

**Never fetch Spotify data from an HTTP endpoint. Not open.spotify.com,
not the oembed endpoint, not api.spotify.com. Not as a primary source,
not as a fallback.**

Playback state, playback control, playlist contents, track titles,
artists, cover art: every one of these goes through the local Spotify
client over the Chrome DevTools Protocol, by calling the service xpui
itself uses for that data.

**Why:** the public endpoints are rate limited per IP and the Web API is
throttled per token. Both have turned every track on screen into its bare
id. The client is signed in, holds the data, caches it, and is the source
its own screen draws from.

**How:** resolve the xpui service by `Symbol.for(name)` through the React
registry context and call it. Never by webpack module id. When a new kind
of data is needed, find the xpui service that serves it. Read
[docs/desktop/spotify-bridge/](docs/desktop/spotify-bridge/) first.

## Layout

- `apps/desktop` — Tauri app. Rust in `src-tauri/src/spotify/` is the CDP
  bridge to the Spotify client.
- `apps/server` — signaling server, deployed as a Compose stack
  (`wm deploy server`).
- `apps/site` — static site, deployed by GitHub Actions on push.
- `packages/room` — room UI. `packages/protocol` — wire types and pure
  queue logic. `packages/ui` — design primitives.

## Docs

`docs/` is a tree that mirrors the architecture. One topic per file.
`docs/future-work/` holds proposals that are not built.
