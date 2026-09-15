# Playlist fetch failures

`fetch_playlist` splits its failures in two, and the split drives whether the
app deletes one of the user's playlists.

- **Gone** — the client answered and said no such playlist. A linked playlist
  that gets this is dropped.
- **Unreachable** — we never got an answer. Client closed, connection dropped,
  service missing, call hung. The playlist is left exactly as it is.

Everything ambiguous classifies as unreachable. A wrong unreachable costs a
retry. A wrong gone deletes content the user cannot get back from us.

## The only gone signal

The client's playlist service rejects a missing playlist with exactly:

```
Invalid playlist or members response!
```

The error carries no `status`, no `code`, and no own enumerable keys. The
message string is the only discriminator there is. `classify_js_failure` keys
on that substring and nothing else.

If Spotify rewords it, the match stops firing and linked playlists stop
auto-dropping. That is the safe direction to break in, and it is deliberate.

## Why the page catches its own rejection

The injected script wraps `getPlaylist` in try/catch and returns
`{ok: false, error}` as data. Letting the promise reject would surface in Rust
as an opaque `JS exception:` blob wrapping a serialized stack trace, and
telling the two failure kinds apart would mean substring-matching that.

## The timeout

`fetch_playlist` wraps itself in a 12-second `tokio::time::timeout`.

`CdpClient::evaluate` passes CDP `timeout: 15000`, but that bounds script
*execution* — it does not cancel a promise the script is awaiting.
`getPlaylist` returns a promise, so without a timeout here a client that never
settles it hangs the call forever. A hang must read as unreachable, never as
gone.

The 12 seconds sits under CDP's 15 so the two do not race.

## Across the boundary

The error serializes as `{kind: "gone" | "unreachable", message}`.
`playlist-import.ts` reads the tag back into a `PlaylistFetchError`; a
rejection carrying no recognised tag becomes unreachable.

`with_client_typed` in `spotify/mod.rs` exists for this command alone.
`with_client` flattens every error to a string, which would destroy the
distinction. It also drops the stale CDP connection only on unreachable: a
gone answer means the client talked to us, so the connection is fine.
