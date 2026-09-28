import { ContextMenuItem } from "@spotjam/ui";
import type { PlaylistTrack } from "@spotjam/protocol";
import { useQueueActions } from "../queue-actions-context";

/** Puts the right-clicked tracks at the end of our queue. */
export function AddToQueueItem({ tracks }: { tracks: PlaylistTrack[] }) {
  const { append } = useQueueActions();
  return <ContextMenuItem onSelect={() => append(tracks)}>Add to queue</ContextMenuItem>;
}
