// Turning track references into queue items the server will accept.
//
// A `QueueItem` must carry its track's length: the server advances the pointer
// on durations alone, so an item without one would either be rejected or expire
// the instant it started. A link does not carry a length, so it is looked up.
//
// The lookup is the only I/O here, and it arrives as a port rather than a
// module import — which is what lets this be tested with a fixture.

import type { PlaylistTrack, QueueItem } from "@spotjam/protocol";

import type { TrackMetadataSource } from "../ports/track-metadata";
import type { ParsedTrack } from "./spotify-link";
import { toQueueItems, type DurationedTrack } from "./room-client";

/**
 * Resolve each track's length, then mint queue items.
 *
 * A track whose metadata will not resolve is dropped. Sending it with a zero
 * length would be worse than not sending it: the server would start it and end
 * it in the same tick, taking the rest of the queue with it.
 */
export async function resolveQueueItems(
  metadata: TrackMetadataSource,
  tracks: ParsedTrack[],
): Promise<QueueItem[]> {
  return toQueueItems(await withDurations(metadata, tracks));
}

/**
 * Resolve each track's length, then shape them as playlist tracks.
 *
 * The same rule as above: a track with no resolvable length is dropped rather
 * than shared at zero, because a peer would enqueue it and stall their room.
 */
export async function resolvePlaylistTracks(
  metadata: TrackMetadataSource,
  tracks: ParsedTrack[],
): Promise<PlaylistTrack[]> {
  const resolved = await withDurations(metadata, tracks);
  return resolved.map((track) => ({
    uri: track.uri,
    trackId: track.trackId,
    durationMs: track.durationMs,
  }));
}

/**
 * Attach a length to each track, dropping the ones that have none.
 *
 * Lookups go out together rather than in sequence: the desktop adapter batches
 * whatever is asked for in one tick into a single call to the Spotify client.
 */
async function withDurations(
  metadata: TrackMetadataSource,
  tracks: ParsedTrack[],
): Promise<DurationedTrack[]> {
  const infos = await Promise.all(tracks.map((track) => metadata.resolve(track.uri)));
  const out: DurationedTrack[] = [];
  for (const [index, info] of infos.entries()) {
    const track = tracks[index];
    if (track === undefined || info === null || info.durationMs <= 0) continue;
    out.push({ ...track, durationMs: info.durationMs });
  }
  return out;
}
