import { useCallback, useEffect, useState } from "react";
import type {
  ConnectionStatus,
  Participant,
  PlaybackPointer,
  QueueItem,
  Room,
  SessionEntry,
} from "../lib/room";
import { toQueueItems } from "../lib/room";
import { displayedProgress } from "../lib/progress";
import type { ParsedLinks, ParsedPlaylist, ParsedTrack } from "../lib/spotify-link";
import { importPlaylist } from "../lib/playlist-import";
import { usePlaylists } from "./use-playlists";
import { NowPlaying } from "./NowPlaying";
import { BroadcastToggle } from "./BroadcastToggle";
import { DetailPane } from "./DetailPane";
import { QueueTracks, type QueueSource } from "./QueueTracks";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import { Sidebar, type Selection } from "./Sidebar";
import { useRoomSnapshot } from "./use-room-snapshot";
import styles from "./QueueView.module.css";

export function QueueView({
  room,
  roomId,
  username,
}: {
  room: Room;
  roomId: string;
  username: string;
}) {
  const { status, participants, sessionQueue, pointer, leaderProgress, myQueue, queueOf } =
    useRoomSnapshot(room);
  const playlistsApi = usePlaylists();
  const [selection, setSelection] = useState<Selection>("session");
  const [pane, setPane] = useState<PaneSelection>(QUEUE_PANE);
  const now = useNowTicker(pointer.itemId !== null);

  const { createWithTracks } = playlistsApi;

  // An imported playlist becomes a new local playlist and takes over the view.
  const onImported = useCallback(
    (name: string, tracks: ParsedTrack[]) => {
      const id = createWithTracks(name, tracks);
      setSelection(room.myUserId);
      setPane(id);
    },
    [createWithTracks, room.myUserId],
  );

  const { importStatus, startImports } = usePlaylistImport(onImported);

  const broadcasting = room.isBroadcasting();
  const ownerName = ownerNameOf(participants, pointer.ownerId);
  const currentItem = currentItemOf(pointer, ownerName);
  const progress = displayedProgress(pointer, leaderProgress, now);

  const queueSource = queueSourceOf(selection, {
    myUserId: room.myUserId,
    sessionQueue,
    myQueue,
    queueOf,
    broadcasting,
    ownerNameFor: (userId) => nameOf(participants, userId),
  });

  function appendTracks(tracks: ParsedTrack[]) {
    room.appendToMyQueue(toQueueItems(tracks, username));
  }

  /**
   * Every drop and paste lands here: the tracks go wherever that surface sends
   * them, and any playlist links import as new local playlists alongside.
   */
  function handleLinks(links: ParsedLinks, onTracks: (tracks: ParsedTrack[]) => void) {
    if (links.tracks.length > 0) onTracks(links.tracks);
    if (links.playlists.length > 0) startImports(links.playlists);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.mark}>spotjam</div>
        <div className={styles.headerRight}>
          <div className={statusClass(status)}>
            <span className={styles.statusDot} />
            {statusLabel(status, participants.length)}
          </div>
          <div className={styles.roomCode}>{roomId}</div>
          <BroadcastToggle
            broadcasting={broadcasting}
            onToggle={() => room.setBroadcasting(!room.isBroadcasting())}
          />
        </div>
      </header>

      <div className={styles.body}>
        <Sidebar
          participants={participants}
          playingOwnerId={pointer.ownerId}
          selection={selection}
          onSelect={(next) => {
            setSelection(next);
            setPane(QUEUE_PANE);
          }}
        />

        <main className={styles.main}>
          <NowPlaying
            item={currentItem}
            ownerName={ownerName}
            progress={progress}
            isPaused={pointer.isPaused}
            onTogglePause={() => room.setPaused(!pointer.isPaused)}
            onSkip={() => room.skip()}
            onSeek={(ms) => room.seekTo(ms)}
          />

          {selection === "session" ? (
            <div className={styles.sessionPane}>
              <QueueTracks
                source={queueSource}
                importStatus={importStatus}
                onLinks={(links) => handleLinks(links, appendTracks)}
                onMove={(from, to) => room.moveInMyQueue(from, to)}
                onSendToTop={(itemId) => room.sendToTopOfMyQueue(itemId)}
                onRemove={(itemId) => room.removeFromMyQueue(itemId)}
                onShuffle={() => room.shuffleMyQueue()}
                onClear={() => room.clearMyQueue()}
              />
            </div>
          ) : (
            <DetailPane
              api={playlistsApi}
              queue={queueSource}
              selected={pane}
              onSelect={setPane}
              onAddToQueue={appendTracks}
              onReplaceQueue={(tracks) => room.replaceMyQueue(toQueueItems(tracks, username))}
              onQueueLinks={(links) => handleLinks(links, appendTracks)}
              onLinks={handleLinks}
              onMove={(from, to) => room.moveInMyQueue(from, to)}
              onSendToTop={(itemId) => room.sendToTopOfMyQueue(itemId)}
              onRemove={(itemId) => room.removeFromMyQueue(itemId)}
              onShuffleQueue={() => room.shuffleMyQueue()}
              onClear={() => room.clearMyQueue()}
              importStatus={importStatus}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/** The sidebar selection decides which queue the detail pane shows. */
function queueSourceOf(
  selection: Selection,
  room: {
    myUserId: string;
    sessionQueue: SessionEntry[];
    myQueue: QueueItem[];
    queueOf: (userId: string) => QueueItem[];
    broadcasting: boolean;
    ownerNameFor: (userId: string) => string;
  },
): QueueSource {
  if (selection === "session") {
    return { kind: "session", entries: room.sessionQueue };
  }
  if (selection === room.myUserId) {
    return { kind: "mine", items: room.myQueue, isBroadcasting: room.broadcasting };
  }
  return {
    kind: "other",
    items: room.queueOf(selection),
    ownerName: room.ownerNameFor(selection),
  };
}

function nameOf(participants: Participant[], userId: string): string {
  return participants.find((p) => p.userId === userId)?.username ?? "someone";
}

const STATUS_LINGER_MS = 4000;

/**
 * Runs playlist imports and reports one line about them. Failures surface as
 * that line — never as a thrown promise — because a bad link is an ordinary
 * thing for a user to drop.
 */
function usePlaylistImport(onImported: (name: string, tracks: ParsedTrack[]) => void): {
  importStatus: string | null;
  startImports: (playlists: ParsedPlaylist[]) => void;
} {
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const startImports = useCallback(
    (playlists: ParsedPlaylist[]) => {
      if (playlists.length === 0) return;
      setImportStatus(
        `Importing ${playlists.length} playlist${playlists.length === 1 ? "" : "s"}...`,
      );

      void Promise.all(
        playlists.map(async (playlist) => {
          const imported = await importPlaylist(playlist.uri);
          onImported(imported.name, imported.tracks);
        }),
      ).then(
        () => setImportStatus(null),
        (error: unknown) => setImportStatus(`Couldn't import that playlist: ${messageOf(error)}`),
      );
    },
    [onImported],
  );

  // Clear a failure line on its own rather than leaving it up forever.
  useEffect(() => {
    if (!importStatus?.startsWith("Couldn't")) return;
    const id = setTimeout(() => setImportStatus(null), STATUS_LINGER_MS);
    return () => clearTimeout(id);
  }, [importStatus]);

  return { importStatus, startImports };
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Wall clock, resampled every 500ms, but only while something is playing. */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

/** The playing track lives in the pointer, not in any queue — rebuild a card-shaped view of it. */
function currentItemOf(pointer: PlaybackPointer, ownerName: string): QueueItem | null {
  if (!pointer.itemId || !pointer.uri) return null;
  return {
    id: pointer.itemId,
    uri: pointer.uri,
    trackId: pointer.uri.replace("spotify:track:", ""),
    addedBy: ownerName,
  };
}

function ownerNameOf(participants: Participant[], ownerId: string | null): string {
  if (!ownerId) return "someone";
  return participants.find((p) => p.userId === ownerId)?.username ?? "someone";
}

function statusClass(status: ConnectionStatus): string {
  if (status.socket === "connected" && status.synced) return styles.statusLive;
  if (status.socket === "disconnected") return styles.statusDown;
  return styles.statusPending;
}

function statusLabel(status: ConnectionStatus, listeners: number): string {
  if (status.socket === "disconnected") return "disconnected";
  if (status.socket === "connecting" || !status.synced) return "connecting";
  return listeners === 1 ? "just you" : `${listeners} listening`;
}
