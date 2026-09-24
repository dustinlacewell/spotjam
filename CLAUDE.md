# spotjam

## ⚠️ ALL SPOTIFY DATA COMES FROM THE SIGNED-IN CLIENT OVER CDP

**Never fetch Spotify data from a lookup API. Not open.spotify.com, not
the oembed endpoint, not api.spotify.com. Not as a primary source, not
as a fallback.**

Playback state, playback control, playlist contents, track titles,
artists, album names: every one of these goes through the local Spotify
client over the Chrome DevTools Protocol, by calling the service xpui
itself uses for that data.

**Why:** those endpoints are rate limited per IP and the Web API is
throttled per token. Both have turned every track on screen into its bare
id. The client is signed in, holds the data, caches it, and is the source
its own screen draws from.

**How:** resolve the xpui service by `Symbol.for(name)` through the React
registry context and call it. Never by webpack module id. When a new kind
of data is needed, find the xpui service that serves it. Read
[docs/desktop/spotify-bridge/](docs/desktop/spotify-bridge/) first.

**Cover art images are the one exception, and it is settled.**
`i.scdn.co/image/<file_id>` is a content-addressed image CDN, and it is
where the signed-in client itself loads every cover it draws — verified
by probing the live client's own DOM. It is not a throttled lookup API
and the rule above does not reach it. Do not "fix" it, and do not go
looking for an internal image-bytes service; there isn't one. See
[docs/desktop/spotify-bridge/cover-art-comes-from-the-image-cdn.md](docs/desktop/spotify-bridge/cover-art-comes-from-the-image-cdn.md).

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

## Tests — run everything that could have changed, nothing more

The full suite (`pnpm run test` = `pnpm -r test`, every workspace) protects
review and CI — it is not the default for a single edit. Pick the tier:

- **Iterating on or adding a test:** run that test file (or the suite it
  lives in) only, e.g.
  `pnpm --filter @spotjam/desktop exec vitest run src/lib/playback/reconcile.test.ts`
- **Small patch confined to one package/subsystem:** that package's scoped
  suite, e.g. `pnpm --filter @spotjam/desktop exec vitest run src/lib/playback`,
  `pnpm --filter @spotjam/server test`.
- **Cross-cutting change** (protocol, bridge, shared types): scoped suites for
  every touched boundary plus its dependents.
- **Requesting review, or touching CI/build config:** full suite. Nothing in
  CI runs the tests today — run the full suite yourself before a release.

Tests are colocated next to source (`*.test.ts` alongside the module).
Rust bridge tests are inline `#[cfg(test)]` modules in
`src-tauri/src/spotify/`; scope with `cargo test <module path>`, e.g.
`cargo test spotify::playlist_api`.

Build: `pnpm run build`.
