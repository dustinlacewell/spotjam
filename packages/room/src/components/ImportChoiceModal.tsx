import { Button, HintLine, Modal } from "@spotjam/ui";
import type { ParsedPlaylist } from "../lib/spotify-link";

/**
 * A dropped playlist link means one of two things, and only the user knows
 * which: take a copy of the tracks, or mirror the Spotify playlist.
 *
 * `playlists` is what the drop carried; null closes the dialog.
 */
export function ImportChoiceModal({
  playlists,
  onClose,
  onCopy,
  onLink,
}: {
  playlists: ParsedPlaylist[] | null;
  onClose: () => void;
  onCopy: (playlists: ParsedPlaylist[]) => void;
  onLink: (playlists: ParsedPlaylist[]) => void;
}) {
  const pending = playlists ?? [];
  const count = pending.length;
  const noun = count === 1 ? "playlist" : `${count} playlists`;

  return (
    <Modal
      open={playlists !== null}
      title={`Copy or link ${noun}?`}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onCopy(pending);
              onClose();
            }}
          >
            Copy
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onLink(pending);
              onClose();
            }}
          >
            Link
          </Button>
        </>
      }
    >
      <HintLine tone="muted">
        A copy is yours to edit. A link stays read-only and syncs from Spotify.
      </HintLine>
    </Modal>
  );
}
