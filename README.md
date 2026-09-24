# spotjam

A shared-listening desktop app: rooms of people watching one Spotify
session together, driven by the Spotify client already signed in on your
machine. `apps/desktop` is a Tauri app whose Rust side
(`src-tauri/src/spotify/`) is a CDP bridge into that client;
`apps/server` is the signaling server rooms connect through;
`apps/site` is the static site. `packages/room` holds the room UI,
`packages/protocol` the wire types and pure queue logic, `packages/ui`
the design primitives.

## ⚠️ All Spotify data comes from the signed-in client over CDP

Never fetch Spotify data from a lookup API — not open.spotify.com, not
the oembed endpoint, not api.spotify.com. Playback state and control,
playlists, track metadata all go through the local Spotify client via
the Chrome DevTools Protocol. The one settled exception is cover art
(`i.scdn.co` image CDN). See
[docs/desktop/spotify-bridge/](docs/desktop/spotify-bridge/) and
[CLAUDE.md](CLAUDE.md) before touching bridge code.

## Running the Spotify client

The bridge attaches to the Spotify client's Chrome DevTools Protocol
port, and Spotify only exposes one when launched with
`--remote-debugging-port=9222`. The bridge will start Spotify itself
with the flag if none is running — but it will **not** restart a Spotify
that is already running without the flag ([connection
lifecycle](docs/desktop/spotify-bridge/connection-lifecycle.md)), so a
normally-launched Spotify blocks the bridge until you relaunch it.

From a terminal:

```
spotify --remote-debugging-port=9222
```

On Linux, make every normal launch carry the flag by editing the
desktop entry (typically
`~/.local/share/applications/spotify.desktop` or the distro's copy under
`/usr/share/applications/` — copy it to `~/.local/share/applications/`
rather than editing the original) and appending the flag to the `Exec=`
line:

```
Exec=spotify --remote-debugging-port=9222 %U
```

Flatpak installs instead use
`--command=spotify --remote-debugging-port=9222` style overrides — check
how your Spotify is installed.

## Bridge connection states

The CDP connection is a state, not a fact — `no-spotify`, `no-debug-port`,
`booting`, `ready`, `lost`. Commands fail with `spotify bridge: <state>`
unless the bridge is `ready`. See
[docs/desktop/spotify-bridge/connection-lifecycle.md](docs/desktop/spotify-bridge/connection-lifecycle.md).

## Build & verify

```
pnpm install
pnpm run test
pnpm run build
```

Deploy the signaling server with `wm deploy server` (Docker Compose).
The site deploys via GitHub Actions on push.

## Docs

`docs/` mirrors the architecture, one topic per file. Start at
[docs/desktop/spotify-bridge/](docs/desktop/spotify-bridge/).

## Nix

`shell.nix` at the repo root pins the toolchain (it is the canonical
dependency list). With nix + direnv, create an `.envrc` file containing
`use nix` (it is gitignored, so this is a one-time local step) and run
`direnv allow`. Without direnv, replicate the listed deps.
