import { useState } from "react";
import { Link } from "lucide-react";
import { Button, ListRow, TextField } from "@spotjam/ui";
import { isEditable, type Playlist } from "../lib/playlists";
import type { ParsedPlaylist } from "../lib/spotify-link";
import { TrackDropZone } from "./TrackDropZone";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import styles from "./PlaylistsPanel.module.css";

export function PlaylistList({
  playlists,
  queueCount,
  queueLabel,
  selected,
  renamingId,
  readOnly,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCreate,
  onLinkPlaylist,
  onImportPlaylists,
}: {
  playlists: Playlist[];
  /** Track count for the pinned queue row. */
  queueCount: number;
  /** "Your queue" on your own page, "{name}'s queue" on someone else's. */
  queueLabel: string;
  selected: PaneSelection;
  renamingId: string | null;
  /** Someone else's page: no creating, renaming or deleting. */
  readOnly: boolean;
  onSelect: (selection: PaneSelection) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onCreate: () => void;
  /** Opens the dialog that links a Spotify playlist. */
  onLinkPlaylist: () => void;
  /** A playlist link dropped anywhere on this list asks whether to copy or link it. */
  onImportPlaylists: (playlists: ParsedPlaylist[]) => void;
}) {
  const listBody = (
    <>
      <ul className={styles.playlists}>
        <li>
          <ListRow
            as="div"
            className={styles.row}
            selected={selected === QUEUE_PANE}
            onClick={() => onSelect(QUEUE_PANE)}
          >
            <span className={styles.rowName}>{queueLabel}</span>
            <span className={styles.rowCount}>{queueCount}</span>
          </ListRow>
        </li>

        {playlists.map((playlist) => (
          <li key={playlist.id}>
            {renamingId === playlist.id ? (
              <RenameRow
                initial={playlist.name}
                onCommit={(name) => onCommitRename(playlist.id, name)}
                onCancel={onCancelRename}
              />
            ) : (
              <ListRow
                as="div"
                className={styles.row}
                selected={playlist.id === selected}
                onClick={() => onSelect(playlist.id)}
                onDoubleClick={() => isEditable(playlist) && !readOnly && onStartRename(playlist.id)}
              >
                <span className={styles.rowName}>{playlist.name}</span>
                {/* Marks the row as a mirror of a Spotify playlist. A peer's
                    playlist reaches us as a plain copy, so it never shows one. */}
                {playlist.source.kind === "spotify" && (
                  <Link
                    className={styles.rowLink}
                    size={12}
                    strokeWidth={2}
                    aria-label="Linked to Spotify"
                  />
                )}
                <span className={styles.rowCount}>{playlist.rows.length}</span>
              </ListRow>
            )}
          </li>
        ))}
      </ul>

      {!readOnly && (
        <div className={styles.listActions}>
          <Button variant="ghost" size="sm" onClick={onCreate}>
            + New playlist
          </Button>
          <Button variant="ghost" size="sm" onClick={onLinkPlaylist}>
            Link playlist
          </Button>
        </div>
      )}
    </>
  );

  if (readOnly) {
    return <div className={styles.listColumn}>{listBody}</div>;
  }

  return (
    <TrackDropZone
      className={`${styles.listColumn} ${styles.dropZone}`}
      onLinks={(links) => {
        if (links.playlists.length > 0) onImportPlaylists(links.playlists);
      }}
    >
      {listBody}
    </TrackDropZone>
  );
}

function RenameRow({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <TextField
      value={value}
      onChange={setValue}
      size="sm"
      emphasis
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
