import { useState } from "react";
import type { Playlist } from "../lib/playlists";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import styles from "./PlaylistsPanel.module.css";

export function PlaylistList({
  playlists,
  queueCount,
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
          <div
            className={selected === QUEUE_PANE ? styles.rowSelected : styles.row}
            onClick={() => onSelect(QUEUE_PANE)}
          >
            <span className={styles.rowName}>Current queue</span>
            <span className={styles.rowCount}>{queueCount}</span>
            {!readOnly && <span className={styles.actionSpacer} />}
          </div>
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
              <div
                className={playlist.id === selected ? styles.rowSelected : styles.row}
                onClick={() => onSelect(playlist.id)}
                onDoubleClick={() => !readOnly && onStartRename(playlist.id)}
              >
                <span className={styles.rowName}>{playlist.name}</span>
                <span className={styles.rowCount}>{playlist.tracks.length}</span>
                {!readOnly && (
                  <button
                    type="button"
                    className={styles.rowRemove}
                    aria-label={`Delete ${playlist.name}`}
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(playlist.id);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {!readOnly && (
        <button type="button" className={styles.newButton} onClick={onCreate}>
          + New playlist
        </button>
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
    <input
      className={styles.renameInput}
      value={value}
      autoFocus
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
