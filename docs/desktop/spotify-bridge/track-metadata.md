# Track metadata through the client's metadata service

Track titles, artists and cover art come from the same machinery xpui uses
to draw them: its metadata extensions API, fetched over the client's own
transport. Nothing is fetched from open.spotify.com or the Web API.

## Path

1. `apps/desktop/src/lib/track-metadata.ts` receives one URI per lookup
   from `@spotjam/room` and hands the id to a batch lookup
   (`lib/batch-lookup.ts`). Lookups made in the same tick leave as one
   `spotify_fetch_tracks` invoke.
2. `spotify/track_api.rs` resolves the `PlaylistAPI` service over CDP and
   stashes its `_metadataExtensionsAPI`. That object's `fetch` takes
   `[uri, kind]` tuples and returns, per URI and kind, a protobuf `Any`
   whose `value` is the raw message. Kind 10 is `TRACK_V4`, a
   `spotify.metadata.Track`.
3. The injected script returns those bytes base64-encoded. Rust decodes
   them with prost using the fields the app reads: name, artists, and the
   album's cover group. An image's `file_id` becomes
   `https://i.scdn.co/image/<hex>`.

An unknown URI comes back with no entry for kind 10, and the command
returns `null` for it.

## Caching

The client caches metadata itself. On top of that the batch lookup caches a
hit for the session, and a miss or a failed batch stands for 30 seconds
before the track is asked again. The room's list hooks re-ask for every
unresolved track on each render, so that miss window is what keeps a
throttled or offline client from turning into a request storm.

## Why not the public endpoints

The first resolver fetched each track's public embed page, then the oembed
endpoint, both unauthenticated. Spotify rate limits those per IP, and one
busy session was enough to get every request answered with 429. The Web
API with the client's token is throttled per token in the same way. The
client's own metadata service is the source xpui trusts, and it is what the
signed-in client uses for every list on screen.

## Finding this again

`xpui.spa` ships a V8 snapshot, not readable JS, so the runtime is the
only reference. `String(api.fetch)` on the stashed object shows the argument
shape; the metadata service client's `SERVICE_ID` is
`spotify.mdata_esperanto.proto.MetadataService`.
