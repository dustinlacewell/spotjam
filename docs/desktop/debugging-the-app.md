# Debugging the app as an agent

How to attach to the running pieces of spotjam from outside, what each
surface actually speaks, and what an agent can drive from a terminal.
Everything below was exercised on this machine; anything that could not be
tested is said so.

## The pieces and their attach surfaces

| Piece | Process | Attach surface | Agent-usable over CDP? |
| --- | --- | --- | --- |
| Spotify client | `spotify` (Flatpak) | Chromium CDP on `127.0.0.1:9222` | **yes** |
| spotjam webview | `target/debug/spotjam` | WebKit remote inspector (`WEBKIT_INSPECTOR_SERVER`) | **no** |
| Signaling server | `pnpm dev` in `apps/server` | its own WebSocket protocol (`ws://127.0.0.1:4444`) | yes (as a room peer) |

The app's webview is **not a Chromium content shell on Linux** — Tauri 2
uses WebKitGTK (`webkitgtk 2.52.6+abi=4.1` here). There is no CDP on the
webview, ever. See [the webview below](#the-app-webview-webkitgtk) for what
its debug port is and is not.

## Launching the stack

1. **Spotify with its debug port** (the bridge never restarts a client that
   is already running without it):

   ```
   flatpak run com.spotify.Client --remote-debugging-port=9222
   ```

   Verify: `curl -s http://127.0.0.1:9222/json/list` returns a `page` target
   titled `Spotify - Web Player`. Spotify is Chromium inside (`Chrome/146`
   engine), so this is real CDP.

2. **The signaling server** (only if you want to test rooms locally):

   ```
   cd apps/server && pnpm dev     # listens on 0.0.0.0:4444
   ```

   Caveat: the desktop app's `DEFAULT_SERVER_URL` is the deployed
   `wss://yjs.ldlework.com` and there is currently no env override, so a
   running app will not talk to the local server. The local server is
   reachable from your own scripts (below); pointing the app at it needs the
   override proposed in [future work](#future-work). Everything here was
   tested against the local server with scripts, and against the deployed
   server with the app.

3. **The app in debug** (cold build takes ~17 min; warm rebuilds are quick):

   ```
   cd apps/desktop
   nix-shell shell.nix --run 'WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223 pnpm tauri dev'
   ```

   `tauri dev` runs Vite on `localhost:1420` and then the binary from
   `src-tauri/target/debug/spotjam`. Verify the bridge is up: the process
   holds an established connection to Spotify
   (`ss -tnp | grep 9222` shows `spotjam <-> spotify`).

## The Spotify client: real CDP, fully drivable

`/json/list` gives a page target with a `webSocketDebuggerUrl`. Any CDP
client works; a minimal one is a websocket plus `Runtime.evaluate` with
`awaitPromise`.

Reading and driving playback goes through the xpui service registry, the
same way the bridge does it (see `apps/desktop/src-tauri/src/spotify/
registry.rs` — resolve by `Symbol.for(name)` through a React fiber walk,
never by webpack module id). The one-expression recipe:

```js
function resolveService(name) {
  let fiberRoot = null;
  for (const el of document.querySelectorAll("*")) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (k) { fiberRoot = el[k]; break; }
  }
  // ... breadth-first walk of f.dependencies.firstContext looking for a
  // context whose memoizedValue has a .resolve function, then
  return registry.resolve(Symbol.for(name));
}
```

With that resolved, these were verified against the live client:

- `resolveService("PlayerAPI").getState()` — full playback state
  (`isPaused`, `item.uri`, `item.name`, `item.duration.milliseconds`,
  `positionAsOfTimestamp`, `restrictions`).
- `.play({ uri: "spotify:track:…" }, {})` — started a track; `getState()`
  then reported `item.uri` set and `duration.milliseconds: 214000`.
- `.pause()` / `.resume()` — flipped `isPaused` `true`/`false` as observed
  by a following `getState()`.
- `.getQueue()` — `{ current, queued, nextUp }`.

Two things to expect:

- **Restrictions are real.** With no playing context, `pause` fails with
  `Command failed with code '1' and reasons 'not_paused,not_playing_context'`.
  Read `restrictions` before driving.
- **Synthetic DOM events do not drive the player.** Clicking or dispatching
  pointer events on `[data-testid=control-button-playpause]` changes
  nothing. Go through the service; the click path is only good for reading
  UI state (e.g. the play/pause button's `aria-label`).

## The app webview: WebKitGTK, no CDP

What was verified:

- The webview is WebKitGTK 4.1 (webkitgtk 2.52.6); Tauri 2 with `features =
  []` in `Cargo.toml` gets devtools in debug builds, but on this platform
  "devtools" means the **Web Inspector**, not CDP.
- `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223` does take effect — the app
  process binds the port (`ss -tlnp` shows `spotjam` on `127.0.0.1:9223`).
- It is **not HTTP and not CDP**. `curl http://127.0.0.1:9223/json` (and
  `/`, `/json/list`, websocket upgrade attempts) get an empty reply; the
  port speaks WebKit's proprietary remote-inspector protocol, whose client
  is another WebKitGTK process.

So an agent cannot attach to the app's webview the way it attaches to the
Spotify client. What was attempted and failed: speaking raw HTTP/websocket
to port 9223 (silent), and building a small WebKitGTK viewer process to
bridge to the inspector (segfaulted under a mixed nix environment). The
Web Inspector window that Tauri debug builds can open is for a human at the
desktop, not for tooling.

What an agent can do instead:

- **Read/driver state through the signaling protocol.** A script that
  speaks the wire protocol can join the same room as the app and observe
  the queue and pointer exactly as the app's UI does — the server
  broadcasts full `room-state` snapshots to every peer. That is the closest
  thing to "read the room UI state" without the inspector.
- **Drive playback via the room, not the webview.** The app's driver
  consumes room ops (`enqueue`, `set-paused`, `seek`, `skip`) when it is
  the broadcaster; the resulting Spotify commands land through the bridge
  and are observable over the Spotify CDP port.

## Simulating a second peer from a script

The protocol is small enough to speak from ~60 lines of Node
(`node:crypto` for ed25519, global `WebSocket`). The pieces, all matching
`packages/protocol`:

1. ed25519 keypair; pubkey hex (32 bytes) is the identity.
2. Canonical JSON for signing: keys sorted at every depth, no whitespace —
   mirror `canonicalize` from `packages/protocol/src/canonical.ts`.
3. Every frame is an envelope `{ nonce, payload, pubkey, timestamp,
   signature }` where `signature` = ed25519 over the canonical bytes of
   `{ nonce, payload, pubkey, timestamp }`.
4. Handshake: send `{ type: "hello" }`; expect `error unknown-identity`
   the first time; answer `{ type: "register", username }`; get
   `registered`.
5. Ops: `join-room`, `set-broadcasting`, `enqueue` (`items: [{ id, uri,
   trackId, durationMs }]`), `set-paused`, `seek`, `skip`, … Server events:
   `room-state` carries the full snapshot (participants, sessionQueue,
   myQueue, pointer).

Verified transcript against the local server (`ws://127.0.0.1:4444`):
open → `unknown-identity` → `registered` → `room-state` snapshots showing
the joined participant, then the enqueued track appearing in `myQueue`
after an `enqueue` op. Rooms do not require distinct machines, but the
two-peers-in-one-room case was **not fully verified**: two concurrent
script peers each received their own post-join snapshot, and neither saw
the other's join arrive — whether that is script lifetime, a publish
missed, or a server quirk was not chased down. Confirm with two long-lived
peers before relying on cross-peer snapshot sync from scripts. Note the
client distinguishes
`sessionQueue` (broadcaster's play queue) from `myQueue` per peer — a
non-broadcaster's `enqueue` lands in `myQueue`.

## Caveats (not testable on one machine)

- Real network paths: the local tests ran over loopback; TLS, NAT traversal
  and latency between machines were not exercised.
- The full app-UI → driver → bridge → Spotify chain was not observed
  end-to-end here, because the webview cannot be attached to (above). The
  two halves were verified separately: the room ops flow (server side) and
  the Spotify drive (client side). The driver's own logic is covered by
  unit tests in `apps/desktop/src/lib/playback/`.
- Direct `PlayerAPI` calls from a script act on the client outside the
  bridge — the bridge and the room will see the state change through its
  observer, but a script-driven command is not a room command.

## Future work

Worth a card each:

- **Debug-only Tauri command / HTTP debug endpoint** exposing
  `spotify_bridge_state`, the current room session and driver mode, so an
  agent can read app state without the webview inspector.
- **Server-URL override** (`SPOTJAM_SERVER_URL` env or a stored pref) so the
  app can be pointed at a local signaling server for testing.
- **`isTauri` fallback for the browser page**: the same frontend served by
  Vite at `localhost:1420` cannot run in a plain browser tab because
  identity and bridge go through Tauri `invoke`; a degraded read-only
  browser mode would give agents a real DOM to inspect.
