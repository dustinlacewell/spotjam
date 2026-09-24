# Debugging the app as an agent

How to attach to the running pieces of spotjam from outside, and what
each surface actually speaks.

## The pieces and their attach surfaces

| Piece | Process | Attach surface | Agent-usable over CDP? |
| --- | --- | --- | --- |
| Spotify client | `spotify` (Flatpak) | Chromium CDP on `127.0.0.1:9222` | **yes** |
| spotjam webview | `target/debug/spotjam` | WebKit remote inspector (`WEBKIT_INSPECTOR_SERVER`) | **no** |
| Signaling server | `pnpm dev` in `apps/server` | its own WebSocket protocol (`ws://127.0.0.1:4444`) | yes (as a room peer) |

On Linux, the app's webview is not a Chromium content shell — Tauri 2
uses WebKitGTK (`webkitgtk 2.52.6+abi=4.1`). There is no CDP on the
webview, ever, on any platform. See [the webview below](#the-app-webview-webkitgtk)
for what its debug port is and is not.

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
   reachable from your own scripts (see
   [driving the server with the wire-script client](../server/driving-with-the-wire-script.md));
   pointing the app at it needs a server-URL override that does not exist yet.

3. **The app in debug** (cold build takes ~17 min; warm rebuilds are quick).
   `shell.nix` is at the repo root, so run nix-shell from there:

   ```
   nix-shell shell.nix --run 'cd apps/desktop && WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223 pnpm tauri dev'
   ```

   `tauri dev` runs Vite on `localhost:1420` and then the binary from
   `src-tauri/target/debug/spotjam`. Verify the bridge is up: on Linux, the
   process holds an established connection to Spotify
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

With that resolved, the calls an agent needs most:

- `resolveService("PlayerAPI").getState()` — full playback state
  (`isPaused`, `item.uri`, `item.name`, `item.duration.milliseconds`,
  `positionAsOfTimestamp`, `restrictions`).
- `.play({ uri: "spotify:track:…" }, {})` — starts a track; `getState()`
  then reports `item.uri` set and the track's `duration.milliseconds`.
- `.pause()` / `.resume()` — flip `isPaused` `true`/`false`, visible in a
  following `getState()`.
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

On Linux:

- The webview is WebKitGTK 4.1 (webkitgtk 2.52.6); Tauri 2 with `features =
  []` in `Cargo.toml` gets devtools in debug builds, but on this platform
  "devtools" means the **Web Inspector**, not CDP.
- `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223` does take effect — the app
  process binds the port (`ss -tlnp` shows `spotjam` on `127.0.0.1:9223`).
- That port is **not HTTP and not CDP**. `curl http://127.0.0.1:9223/json`
  (and `/`, `/json/list`, websocket upgrade attempts) get an empty reply;
  the port speaks WebKit's proprietary remote-inspector protocol, whose
  client is another WebKitGTK process.

So an agent cannot attach to the app's webview the way it attaches to the
Spotify client. Raw HTTP/websocket to the inspector port does not work,
and there is no lightweight bridge process for it. The Web Inspector
window that Tauri debug builds can open is for a human at the desktop,
not for tooling.

What an agent can do instead:

- **Read/driver state through the signaling protocol.** A script that
  speaks the wire protocol can join the same room as the app and observe
  the queue and pointer exactly as the app's UI does — the server
  broadcasts full `room-state` snapshots to every peer. That is the closest
  thing to "read the room UI state" without the inspector. See
  [driving the server with the wire-script client](../server/driving-with-the-wire-script.md).
- **Drive playback via the room, not the webview.** The app's driver
  consumes room ops (`enqueue`, `set-paused`, `seek`, `skip`) when it is
  the broadcaster; the resulting Spotify commands land through the bridge
  and are observable over the Spotify CDP port.

Direct `PlayerAPI` calls from a script act on the Spotify client outside
the bridge — the bridge and the room see the state change through their
observer, but a script-driven command is not a room command. The driver's
own logic is covered by unit tests in `apps/desktop/src/lib/playback/`.
