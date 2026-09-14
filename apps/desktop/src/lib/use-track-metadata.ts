import { useEffect, useState } from "react";
import { getTrackMetadata, type TrackMetadata } from "./track-metadata";

export function useTrackMetadata(trackUri: string): TrackMetadata | null {
  const [metadata, setMetadata] = useState<TrackMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    getTrackMetadata(trackUri).then((result) => {
      if (!cancelled) setMetadata(result);
    });
    return () => {
      cancelled = true;
    };
  }, [trackUri]);

  return metadata;
}
