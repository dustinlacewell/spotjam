import { useEffect, useState } from "react";
import { useRoomServices } from "../services";
import type { TrackInfo } from "../ports/track-metadata";

/**
 * The metadata resolver reaches the Spotify client over CDP, and that client
 * goes away whenever Spotify restarts or is closed — exactly while a room can
 * be on screen. A rejection is a normal dip, not a crash: leave whatever the
 * hook already holds in place and stay quiet about it.
 */
function ignoreResolutionFailure(error: unknown): void {
  console.warn("spotjam: could not resolve track metadata", error);
}

export function useTrackMetadata(trackUri: string): TrackInfo | null {
  const { trackMetadata } = useRoomServices();
  const [metadata, setMetadata] = useState<TrackInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    // Nothing playing: no lookup, and the empty state stands.
    if (trackUri === "") return;
    void trackMetadata
      .resolve(trackUri)
      .then((result) => {
        if (!cancelled) setMetadata(result);
      })
      .catch(ignoreResolutionFailure);
    return () => {
      cancelled = true;
    };
  }, [trackUri, trackMetadata]);

  return metadata;
}

/** Resolves metadata for a list of tracks at once, keyed by URI. */
export function useTrackMetadataMap(trackUris: string[]): Map<string, TrackInfo> {
  const { trackMetadata } = useRoomServices();
  const [metadata, setMetadata] = useState<Map<string, TrackInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;
    for (const uri of trackUris) {
      if (uri === "" || metadata.has(uri)) continue;
      void trackMetadata
        .resolve(uri)
        .then((result) => {
          if (cancelled || !result) return;
          setMetadata((prev) => new Map(prev).set(uri, result));
        })
        .catch(ignoreResolutionFailure);
    }
    return () => {
      cancelled = true;
    };
  }, [trackUris, trackMetadata]);

  return metadata;
}
