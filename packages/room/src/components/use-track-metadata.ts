import { useEffect, useState } from "react";
import { useRoomServices } from "../services";
import type { TrackInfo } from "../ports/track-metadata";

export function useTrackMetadata(trackUri: string): TrackInfo | null {
  const { trackMetadata } = useRoomServices();
  const [metadata, setMetadata] = useState<TrackInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    // Nothing playing: no lookup, and the empty state stands.
    if (trackUri === "") return;
    void trackMetadata.resolve(trackUri).then((result) => {
      if (!cancelled) setMetadata(result);
    });
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
      void trackMetadata.resolve(uri).then((result) => {
        if (cancelled || !result) return;
        setMetadata((prev) => new Map(prev).set(uri, result));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [trackUris, trackMetadata]);

  return metadata;
}
