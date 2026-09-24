# Agent debug access to the desktop app

Not built.

An agent cannot attach to the app's webview (see
[docs/desktop/debugging-the-app.md](../desktop/debugging-the-app.md)).
These would close that gap. Worth a card each.

- **Debug-only Tauri command / HTTP debug endpoint** exposing
  `spotify_bridge_state`, the current room session, and driver mode, so an
  agent can read app state without the webview inspector.
- **Server-URL override** (`SPOTJAM_SERVER_URL` env or a stored pref) so the
  app can be pointed at a local signaling server for testing.
- **`isTauri` fallback for the browser page**: the same frontend served by
  Vite at `localhost:1420` cannot run in a plain browser tab because
  identity and bridge go through Tauri `invoke`. A degraded read-only
  browser mode would give agents a real DOM to inspect.
