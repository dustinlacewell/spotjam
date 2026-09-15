import { useEffect, useRef, useState } from "react";
import { Button, HintLine, Modal, TextField } from "@spotjam/ui";
import type { ParsedPlaylist } from "../lib/spotify-link";
import { parseSpotifyLinks } from "../lib/spotify-link";
import { carriesTracks, linksFromDrop } from "../lib/drop-links";
import styles from "./LinkPlaylistModal.module.css";

/**
 * Asks for a Spotify playlist link and hands back what it parsed.
 *
 * Takes a pasted link or one dragged in from the Spotify client. A link that
 * names several playlists links all of them, which is what a multi-link drop
 * from Spotify carries.
 */
export function LinkPlaylistModal({
  open,
  onClose,
  onLink,
}: {
  open: boolean;
  onClose: () => void;
  onLink: (playlists: ParsedPlaylist[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isOver, setIsOver] = useState(false);
  const depth = useRef(0);

  // Each opening starts clean: a stale link or error from last time would be
  // one Enter away from creating the wrong playlist.
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    depth.current = 0;
    setIsOver(false);
  }, [open]);

  function submit(value: string) {
    const { playlists } = parseSpotifyLinks(value);
    if (playlists.length === 0) {
      setError("That doesn't look like a Spotify playlist link.");
      return;
    }
    onLink(playlists);
    onClose();
  }

  return (
    <Modal
      open={open}
      title="Link a Spotify playlist"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => submit(text)}>
            Link playlist
          </Button>
        </>
      }
    >
      <div
        className={isOver ? styles.dropZoneOver : styles.dropZone}
        onDragEnter={(e) => {
          if (!carriesTracks(e.dataTransfer)) return;
          depth.current += 1;
          setIsOver(true);
        }}
        onDragOver={(e) => {
          if (!carriesTracks(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!carriesTracks(e.dataTransfer)) return;
          depth.current -= 1;
          if (depth.current <= 0) setIsOver(false);
        }}
        onDrop={(e) => {
          if (!carriesTracks(e.dataTransfer)) return;
          e.preventDefault();
          depth.current = 0;
          setIsOver(false);
          const links = linksFromDrop(e.dataTransfer);
          if (links.playlists.length === 0) {
            setError("That drop carried no playlist link.");
            return;
          }
          onLink(links.playlists);
          onClose();
        }}
      >
        <TextField
          value={text}
          onChange={(value) => {
            setText(value);
            setError(null);
          }}
          placeholder="Paste a playlist link"
          size="sm"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(text);
          }}
        />
        <p className={styles.hint}>or drop a playlist here</p>
      </div>

      <HintLine tone={error ? "error" : "muted"}>
        {error ?? "Spotify keeps owning the playlist. Syncing pulls its changes in."}
      </HintLine>
    </Modal>
  );
}
