# The bridge connection has a lifecycle

The CDP connection to the Spotify client is not a fact. It is a state.
`spotify/session.rs` owns that state and a supervisor task keeps it moving.

## States

| State | Meaning |
|---|---|
| `no-spotify` | No Spotify process, or we could not find out. The launcher started one; the port is not open yet. |
| `no-debug-port` | Spotify was *positively found* running without `--remote-debugging-port=9222`. The bridge cannot attach. It does not restart Spotify. |
| `booting` | The port answers, but the page cannot resolve a service yet. |
| `ready` | Attached to the xpui page; services resolve. |
| `lost` | The socket closed. Spotify quit or restarted. |

Every `spotify_*` command fails at once with `spotify bridge: <state>`
unless the state is `ready`. No command waits for a connection.

## Transitions

- Startup: the supervisor runs one connect. While the state is not `ready`
  it retries with backoff, 1 s doubling to a 10 s cap. Only an attempt the
  supervisor actually ran advances that backoff: a connect that found the
  guard taken watched someone else's attempt, and counting it would climb to
  the ceiling on the strength of a Sync press.
- `ready` → `lost`: the reader task saw the socket close, or a command came
  back with a failure that means the page no longer holds what we resolved
  against. A socket that is still open is not proof the connection means
  anything.

  That failure is recognised by an anchor, never by an English phrase. The
  registry walk stamps its own throws with `spotjam-walk-failed:`, and the lost
  execution context is matched only inside a `CDP protocol error:` frame. The
  text reaching the classifier is not ours alone — `normalise_playlist_uri`
  echoes the caller's paste, and a thrown page error carries whatever a
  playlist or track is named — so matching a bare phrase let a user's paste, or
  a playlist named after the error, drop the gate over a healthy bridge.
- `ready` → `booting` → `ready`: xpui reloaded in place. CDP reports
  `Runtime.executionContextsCleared`; the target id and socket survive,
  `window` usually does not. The supervisor drops the stashed services — a
  same-document navigation clears the context and keeps `window`, which would
  otherwise leave stashes naming services the page has abandoned — and waits
  for the page to resolve again.

  The drop is not best-effort. The event arrives while the page is between
  contexts, so an evaluation issued right then fails; a remount that ignored
  that would report `ready` over stashes it never cleared, which is the case
  the drop exists to prevent. So the supervisor waits for the page to be
  serviceable, drops, and only calls it a remount once the drop was confirmed
  and the page mounted again.
- `no-debug-port` → `ready`: the user restarts Spotify with the flag. The
  retry loop, or the Sync button, attaches.

## The target

Spotify can expose more than one page target. The bridge picks the page
whose URL host is `xpui.app.spotify.com`, never the first page in the list.

## What the app sees

The bridge emits the Tauri event `spotify-bridge` with `{ state }` on
every change and once at startup. `spotify_bridge_state` reads it;
`spotify_connect` forces one attempt. A `spotify_connect` that finds an
attempt already running does not start a second one against the same port —
it waits up to three seconds on the one in flight and reports where that got
to, so the Sync button answers "did it work" rather than "still booting".

## What `ready` is allowed to mean

`ready` promises that a command will reach a service. So the probe that
grants it performs the same walk a command performs — `resolveService`
resolving `PlayerAPI` — rather than asking whether React has mounted
anything. React commits its first host element well before the registry
provider is in the tree, so a fiber is not evidence: the page can carry one
and still throw on the walk.

`PlaybackDriver` subscribes. Its ticks are gated on `ready`: while the state
is anything else it issues nothing and forgets the last reading it took, so
a player it could not watch is never held against the user. On any
transition into `ready` it ticks at once rather than waiting out the poll
interval — it observes the player and commands the difference, which puts
the room's track back without leaving the room.

`SpotifyGate` dims the room screen while the state is not `ready` and offers
Sync. Sync calls `attach()`, so pressing it both forces a connection attempt
and takes the player back if the user had it.
