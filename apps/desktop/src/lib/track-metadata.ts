import { invoke } from "@tauri-apps/api/core";
import type { TrackInfo, TrackMetadataSource } from "@spotjam/room";
import { createBatchLookup } from "./batch-lookup";

/** The desktop app's name for the port's TrackInfo. */
export type TrackMetadata = TrackInfo;

interface RustTrackMetadata {
  title: string;
  artist: string;
  thumbnail_url: string | null;
}

/** Keeps one metadata request a comfortable size; the Rust side chunks too. */
const MAX_BATCH = 50;

/** How long a miss or a failed batch stands before a track is asked for again. */
const MISS_TTL_MS = 30_000;

/**
 * Asks the Spotify client's own metadata service for a batch of tracks (see
 * spotify/track_api.rs). One result per id, in order; null for an unknown id.
 */
async function fetchTracks(trackIds: string[]): Promise<(TrackMetadata | null)[]> {
  try {
    const results = await invoke<(RustTrackMetadata | null)[]>("spotify_fetch_tracks", { trackIds });
    return results.map((data) =>
      data ? { title: data.title, artist: data.artist, thumbnailUrl: data.thumbnail_url } : null,
    );
  } catch (error) {
    console.warn("spotjam: spotify_fetch_tracks failed:", error);
    throw error;
  }
}

const lookupById = createBatchLookup(fetchTracks, { maxBatch: MAX_BATCH, missTtlMs: MISS_TTL_MS });

/**
 * Looks up display metadata for one Spotify track. Lookups made in the same
 * tick travel to the client as one batch; hits are cached for the session.
 */
export function getTrackMetadata(trackUri: string): Promise<TrackMetadata | null> {
  if (trackUri === "") return Promise.resolve(null);
  return lookupById(trackUri.replace("spotify:track:", ""));
}

/** The Tauri-backed adapter the app hands to @spotjam/room. */
export const tauriTrackMetadata: TrackMetadataSource = { resolve: getTrackMetadata };
