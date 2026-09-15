import { useState } from "react";
import { Button, IconButton, ListRow, TextField } from "@spotjam/ui";
import type { Playlist } from "../lib/playlists";
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
  onDelete,
  onCreate,
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
  onDelete: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className={styles.listColumn}>
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
            {!readOnly && <span className={styles.actionSpacer} />}
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
                onDoubleClick={() => !readOnly && onStartRename(playlist.id)}
              >
                <span className={styles.rowName}>{playlist.name}</span>
                <span className={styles.rowCount}>{playlist.tracks.length}</span>
                {!readOnly && (
                  /* The row itself selects on click; the delete glyph must not. */
                  <span
                    className={styles.rowRemove}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton
                      label={`Delete ${playlist.name}`}
                      size="sm"
                      shape="circle"
                      tone="danger"
                      revealOnHover
                      onClick={() => onDelete(playlist.id)}
                    >
                      ✕
                    </IconButton>
                  </span>
                )}
              </ListRow>
            )}
          </li>
        ))}
      </ul>

      {!readOnly && (
        <Button variant="ghost" size="sm" onClick={onCreate}>
          + New playlist
        </Button>
      )}
    </div>
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
