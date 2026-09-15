import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Mark, Pill, StatusDot, type StatusDotTone } from "@spotjam/ui";
import type {
  Participant,
  PlaybackPointer,
  QueueItem,
  SessionEntry,
  SharedPlaylist,
} from "@spotjam/protocol";
import type { Playlist } from "../lib/playlists";
import type { ConnectionStatus } from "../lib/room-client";
import type { Room } from "../ports/room";
import type { ImportedPlaylist } from "../ports/playlist-importer";
import { toQueueItems } from "../lib/room-client";
import { toSharedPlaylists } from "../lib/playlists";
import { displayedProgress } from "../lib/progress";
import type { ParsedLinks, ParsedPlaylist, ParsedTrack } from "../lib/spotify-link";
import { useRoomServices } from "../services";
import { usePlaylists } from "./use-playlists";
import { PlaylistsProvider } from "./playlists-context";
import { NowPlaying } from "./NowPlaying";
import { BroadcastToggle } from "./BroadcastToggle";
import { DetailPane } from "./DetailPane";
import { ImportChoiceModal } from "./ImportChoiceModal";
import { LinkPlaylistModal } from "./LinkPlaylistModal";
import { QueueTracks, type QueueSource } from "./QueueTracks";
import { QUEUE_PANE, type PaneSelection } from "./pane-selection";
import { Sidebar, type Selection } from "./Sidebar";
import { useRoomSnapshot } from "./use-room-snapshot";
import styles from "./QueueView.module.css";

export function QueueView({
  room,
  roomId,
  onSync,
  onLeave,
}: {
  room: Room;
  roomId: string;
  /** Attaches the local player to the room, whatever it is doing. */
  onSync: () => void;
  onLeave: () => void;
}) {
  const { status, participants, sessionQueue, pointer, myProgress, myQueue, queueOf, error } =
    useRoomSnapshot(room);
  const { playlistImporter } = useRoomServices();
  const playlistsApi = usePlaylists(playlistImporter);
  const [selection, setSelection] = useState<Selection>("session");
  const [pane, setPane] = useState<PaneSelection>(QUEUE_PANE);
  const now = useNowTicker(pointer.itemId !== null);

  const { createWithTracks } = playlistsApi;
  const myPubkey = room.myPubkey;

  const { importStatus, startImports } = usePlaylistImport();

  // A playlist link becomes a new playlist, which then takes over the view.
  // Copying takes the tracks and forgets where they came from; linking keeps
  // the tie, so Spotify goes on owning the content and a sync pulls its
  // changes in. Which one a drop means is the user's call, not ours.
  const openImported = useCallback(
    (id: string) => {
      setSelection(myPubkey);
      setPane(id);
    },
    [myPubkey],
  );

  const copyAsNewPlaylist = useCallback(
    (playlists: ParsedPlaylist[]) => {
      startImports(playlists, (imported) => {
        openImported(createWithTracks(imported.name, imported.tracks));
      });
    },
    [startImports, createWithTracks, openImported],
  );

  const linkAsNewPlaylist = useCallback(
    (playlists: ParsedPlaylist[]) => {
      startImports(playlists, (imported) => {
        openImported(
          createWithTracks(imported.name, imported.tracks, {
            kind: "spotify",
            playlistId: imported.playlistId,
            syncedAt: Date.now(),
          }),
        );
      });
    },
    [startImports, createWithTracks, openImported],
  );

  // A drop on the playlist list asks first; the button links outright.
  const [pendingImport, setPendingImport] = useState<ParsedPlaylist[] | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  usePublishedPlaylists(room, playlistsApi.playlists, status.synced);

  // Opening someone else's page asks the room for their public playlists. The
  // answer lands on the room and re-renders us through useRoomSnapshot.
  //
  // The ask needs a joined room, so it waits for sync; before that the server
  // refuses it as `not-in-room` and nothing retries. It also re-runs when the
  // owner's revision moves, which is how a viewer learns their copy went stale
  // — the playlists themselves are never in the snapshot.
  const synced = status.synced;
  const revisionOfSelected = revisionOf(participants, selection);
  useEffect(() => {
    if (!synced) return;
    if (selection === "session" || selection === myPubkey) return;
    if (revisionOfSelected < 0) return;
    room.viewPlaylists(selection);
  }, [room, selection, myPubkey, synced, revisionOfSelected]);

  const broadcasting = room.isBroadcasting();
  const ownerName = nameOf(participants, pointer.ownerPubkey);
  const currentItem = currentItemOf(pointer);
  const progress = displayedProgress(pointer, myProgress, now);

  const queueSource = queueSourceOf(selection, {
    myPubkey,
    sessionQueue,
    myQueue,
    queueOf,
    broadcasting,
    ownerNameFor: (pubkey) => nameOf(participants, pubkey),
    playlistsFor: (pubkey) => room.playlistsOf(pubkey),
  });

  function appendTracks(tracks: ParsedTrack[]) {
    room.appendToMyQueue(toQueueItems(tracks));
  }

  /**
   * A playlist link dropped on the queue has a different meaning than one
   * dropped on the playlist list: its tracks join the queue directly, rather
   * than becoming a playlist. Nothing is stored, so there is nothing to link
   * and nothing to ask about.
   */
  function importIntoQueue(playlists: ParsedPlaylist[]) {
    startImports(playlists, (imported) => appendTracks(imported.tracks));
  }

  /**
   * Every drop and paste lands here: the tracks go wherever that surface
   * sends them, and any playlist links resolve through whichever policy that
   * surface passes in — a new local playlist, or straight into the queue.
   */
  function handleLinks(
    links: ParsedLinks,
    onTracks: (tracks: ParsedTrack[]) => void,
    onPlaylists: (playlists: ParsedPlaylist[]) => void,
  ) {
    if (links.tracks.length > 0) onTracks(links.tracks);
    if (links.playlists.length > 0) onPlaylists(links.playlists);
  }

  return (
    <PlaylistsProvider api={playlistsApi}>
    <div className={styles.page}>
      <header className={styles.header}>
        <Mark size="sm">
          spotjam<span className={styles.roomCode}>: {roomId}</span>
        </Mark>
        <div className={styles.headerRight}>
          <Pill as="span">
            <StatusDot tone={statusTone(status)} />
            {statusLabel(status)}
          </Pill>
          <BroadcastToggle
            broadcasting={broadcasting}
            onToggle={() => room.setBroadcasting(!broadcasting)}
          />
          <Button variant="secondary" size="sm" onClick={onSync}>
            Sync
          </Button>
          <Button variant="secondary" size="sm" onClick={onLeave}>
            Leave room
          </Button>
        </div>
      </header>

      {/* A rejected message is worth a line of its own: a skewed clock looks
          exactly like a dead room otherwise. */}
      {error && <p className={styles.errorBanner}>{error.humanMessage}</p>}

      <div className={styles.body}>
        <Sidebar
          participants={participants}
          sessionQueue={sessionQueue}
          playingOwnerPubkey={pointer.ownerPubkey}
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
                onLinks={(links) => handleLinks(links, appendTracks, importIntoQueue)}
                onMoveMany={(itemIds, beforeItemId) => room.moveManyInMyQueue(itemIds, beforeItemId)}
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
              onReplaceQueue={(tracks) => room.replaceMyQueue(toQueueItems(tracks))}
              onQueueLinks={(links) => handleLinks(links, appendTracks, importIntoQueue)}
              onLinks={(links, onTracks) => handleLinks(links, onTracks, setPendingImport)}
              onLinkPlaylist={() => setLinkOpen(true)}
              onImportPlaylists={setPendingImport}
              onMoveMany={(itemIds, beforeItemId) => room.moveManyInMyQueue(itemIds, beforeItemId)}
              onSendToTop={(itemId) => room.sendToTopOfMyQueue(itemId)}
              onRemove={(itemId) => room.removeFromMyQueue(itemId)}
              onShuffleQueue={() => room.shuffleMyQueue()}
              onClear={() => room.clearMyQueue()}
              importStatus={importStatus}
            />
          )}
        </main>
      </div>

      <ImportChoiceModal
        playlists={pendingImport}
        onClose={() => setPendingImport(null)}
        onCopy={copyAsNewPlaylist}
        onLink={linkAsNewPlaylist}
      />
      <LinkPlaylistModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        onLink={linkAsNewPlaylist}
      />
    </div>
    </PlaylistsProvider>
  );
}

/** The sidebar selection decides which queue the detail pane shows. */
function queueSourceOf(
  selection: Selection,
  room: {
    myPubkey: string;
    sessionQueue: SessionEntry[];
    myQueue: QueueItem[];
    queueOf: (pubkey: string) => QueueItem[];
    broadcasting: boolean;
    ownerNameFor: (pubkey: string) => string;
    playlistsFor: (pubkey: string) => SharedPlaylist[];
  },
): QueueSource {
  if (selection === "session") {
    return { kind: "session", entries: room.sessionQueue };
  }
  if (selection === room.myPubkey) {
    return { kind: "mine", items: room.myQueue, isBroadcasting: room.broadcasting };
  }
  return {
    kind: "other",
    items: room.queueOf(selection),
    ownerName: room.ownerNameFor(selection),
    playlists: room.playlistsFor(selection),
  };
}

/**
 * Keep the room's copy of our public playlists in step with ours.
 *
 * The op is a full replace, so it is sent only when the shared set actually
 * changes — not on every render, and not for a private playlist's edits, which
 * the room never sees. The first send waits for sync: an op before the join
 * lands has no room to apply to.
 */
function usePublishedPlaylists(room: Room, playlists: Playlist[], synced: boolean): void {
  const shared = useMemo(() => toSharedPlaylists(playlists), [playlists]);
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!synced) {
      // A rejoin starts the room's copy empty again, so the next send must go
      // out even when the set itself did not move.
      sentRef.current = null;
      return;
    }
    const encoded = JSON.stringify(shared);
    if (sentRef.current === encoded) return;
    sentRef.current = encoded;
    room.setPublicPlaylists(shared);
  }, [room, shared, synced]);
}

/**
 * The selected member's playlists revision, or -1 when there is no member to
 * ask about — no selection, our own page, or someone who has left.
 */
function revisionOf(participants: Participant[], selection: Selection): number {
  if (selection === "session") return -1;
  return participants.find((p) => p.pubkey === selection)?.playlistsRevision ?? -1;
}

function nameOf(participants: Participant[], pubkey: string | null): string {
  if (!pubkey) return "someone";
  return participants.find((p) => p.pubkey === pubkey)?.username ?? "someone";
}

const STATUS_LINGER_MS = 4000;

/**
 * Fetches dropped or pasted playlist links and reports one status line about
 * it. Failures surface as that line — never as a thrown promise — because a
 * bad link is an ordinary thing for a user to drop.
 *
 * What an imported playlist becomes is the caller's call, chosen per drop
 * surface: `startImports` takes that policy as an argument rather than
 * baking in one global answer, so the playlist list (new local playlist) and
 * the queue (enqueue the tracks) can share this one fetch-and-report
 * mechanism, and its one status line, without contending over which meaning
 * is "the" meaning of a dropped playlist link.
 */
function usePlaylistImport(): {
  importStatus: string | null;
  startImports: (playlists: ParsedPlaylist[], onImported: (imported: ImportedPlaylist) => void) => void;
} {
  const { playlistImporter } = useRoomServices();
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const startImports = useCallback(
    (playlists: ParsedPlaylist[], onImported: (imported: ImportedPlaylist) => void) => {
      if (playlists.length === 0) return;
      setImportStatus(
        `Importing ${playlists.length} playlist${playlists.length === 1 ? "" : "s"}...`,
      );

      void Promise.all(
        playlists.map(async (playlist) => {
          const imported = await playlistImporter.import(playlist.uri);
          onImported(imported);
        }),
      ).then(
        () => setImportStatus(null),
        (error: unknown) => setImportStatus(`Couldn't import that playlist: ${messageOf(error)}`),
      );
    },
    [playlistImporter],
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
function currentItemOf(pointer: PlaybackPointer): QueueItem | null {
  if (!pointer.itemId || !pointer.uri) return null;
  return {
    id: pointer.itemId,
    uri: pointer.uri,
    trackId: pointer.uri.replace("spotify:track:", ""),
  };
}

function statusTone(status: ConnectionStatus): StatusDotTone {
  if (status.socket === "connected" && status.synced) return "accent";
  if (status.socket === "disconnected") return "danger";
  return "muted";
}

function statusLabel(status: ConnectionStatus): string {
  if (status.socket === "disconnected") return "disconnected";
  if (status.socket === "connecting") return "connecting";
  // Socket up, no snapshot yet: the handshake is mid-flight. Saying
  // "connecting" here hid which half was stuck.
  if (!status.synced) return "joining";
  return "Connected";
}
