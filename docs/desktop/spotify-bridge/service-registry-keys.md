# Resolving xpui services by registry key

The desktop app drives the local Spotify client over the Chrome DevTools
Protocol (`apps/desktop/src-tauri/src/spotify/`). The scripts it injects
need two internal xpui services: `PlayerAPI` for playback and
`ListPlatformAPI` for playlist contents.

## How a service is found

xpui keeps its services in a registry that React exposes through a context.
The injected script walks the React fiber tree until it finds a context value
with a `resolve` function, then calls `resolve(key)`.

Every key is `Symbol.for(name)`. `Symbol.for` reads from the global symbol
registry, so a symbol built in our script equals the one xpui registered
under. No access to xpui's module graph is needed.

```js
const playerApi = registry.resolve(Symbol.for("PlayerAPI"));
```

`player_api.rs` and `playlist_api.rs` each hold one such script and stash
the resolved service on `window` for reuse. The stash dies with `window`
on an xpui reload; `connection-lifecycle.md` describes how the bridge
waits for React to mount before it injects again.

## Do not read keys from webpack modules

Until 2026-09-15 the scripts built a mini webpack `require`, loaded the key
module by numeric id (`70968` for `PlayerAPI`, `84020` for
`ListPlatformAPI`) and read the key off its exports. Spotify renumbers
those ids on client updates. One update made every player command fail with
`no module 70968`, and the app showed every track as its bare id.

The numeric ids are an artifact of Spotify's build. The service names are
the stable contract. Build the symbol; do not look it up.

## Checking a service name after a Spotify update

If a service stops resolving, confirm its name against the bundle on disk.
`xpui.spa` is a zip archive.

```sh
mkdir xpui && cd xpui
unzip -q "$APPDATA/Spotify/Apps/xpui.spa"
grep -oh '[a-zA-Z]\+("[A-Za-z]*API")' *.js | sort | uniq -c
```

The helper that wraps the name is `Symbol.for` under a minified alias. The
names in the output are the keys to pass to `registry.resolve`.
