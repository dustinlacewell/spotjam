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
