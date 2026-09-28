import { ContextMenu, ContextMenuSeparator, type Point } from "@spotjam/ui";
import type { PlaylistTrack } from "@spotjam/protocol";
import { AddToQueueItem } from "./AddToQueueItem";
import { PlaylistItems } from "./PlaylistItems";

/** What a right-clicked set of tracks can do: join our queue, land in a
 *  playlist, or make one. */
export function TrackContextMenu({
  at,
  tracks,
  onClose,
}: {
  at: Point | null;
  tracks: PlaylistTrack[];
  onClose: () => void;
}) {
  return (
    <ContextMenu at={at} onClose={onClose}>
      {at !== null && (
        <>
          <AddToQueueItem tracks={tracks} />
          <ContextMenuSeparator />
          <PlaylistItems at={at} tracks={tracks} />
        </>
      )}
    </ContextMenu>
  );
}
