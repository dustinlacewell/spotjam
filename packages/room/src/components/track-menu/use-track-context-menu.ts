import { useCallback, useState } from "react";
import type { PlaylistTrack } from "@spotjam/protocol";
import type { Point } from "@spotjam/ui";

/** Where a track list's context menu is open, and on which tracks. */
export function useTrackContextMenu(): {
  at: Point | null;
  tracks: PlaylistTrack[];
  open(e: React.MouseEvent, tracks: PlaylistTrack[]): void;
  close(): void;
} {
  const [at, setAt] = useState<Point | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);

  return {
    at,
    tracks,
    open: useCallback((e: React.MouseEvent, next: PlaylistTrack[]) => {
      e.preventDefault();
      setTracks(next);
      setAt({ x: e.clientX, y: e.clientY });
    }, []),
    close: useCallback(() => setAt(null), []),
  };
}
