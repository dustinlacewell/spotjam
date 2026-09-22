import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Mark, Pill, StatusDot, type StatusDotTone } from "@spotjam/ui";
import {
  positionAt,
  settleOnce,
  type Participant,
  type PlaybackPointer,
  type PlaylistTrack,
  type QueueItem,
  type SessionEntry,
  type SharedPlaylist,
} from "@spotjam/protocol";
import type { Playlist } from "../lib/playlists";
import type { ConnectionStatus } from "../lib/room-client";
import type { Room } from "../ports/room";
import type { ImportedPlaylist } from "../ports/playlist-service";
import { resolvePlaylistTracks, resolveQueueItems } from "../lib/enqueue";
import { rowsOfTracks, toSharedPlaylists, type PlaylistRow } from "../lib/playlists";
import type { ParsedAlbum, ParsedArtist, ParsedLinks, ParsedPlaylist, ParsedTrack } from "../lib/spotify-link";
import { useRoomServices } from "../services";
import { usePlaylists } from "./use-playlists";
import { PlaylistsProvider } from "./playlists-context";
import { NowPlaying } from "./NowPlaying";
import { AttachChip } from "./AttachChip";
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
  onLeave,
}: {
  room: Room;
  roomId: string;
  onLeave: () => void;
}) {
  const { status, participants, sessionQueue, pointer, myQueue, queueOf, error } =
    useRoomSnapshot(room);
  const { playlistService, trackMetadata } = useRoomServices();
  const playlistsApi = usePlaylists(playlistService);
  const [selection, setSelection] = useState<Selection>("session");
  const [pane, setPane] = useState<PaneSelection>(QUEUE_PANE);
  // A tick, not a time: the clock that matters is the server's, which the room
  // reads for us. This only says "re-read it now".
  useTicker(pointer.itemId !== null);

  const { createWithTracks } = playlistsApi;
  const myPubkey = room.myPubkey;

  const { importStatus, startImports, startListResolution } = usePlaylistImport();

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
        // A copy is ours: the rows keep the tracks and drop Spotify's row
        // identities, which name rows in a playlist this one no longer follows.
        openImported(createWithTracks(imported.name, rowsOfTracks(tracksOfRows(imported.rows))));
      });
    },
    [startImports, createWithTracks, openImported],
  );

  const linkAsNewPlaylist = useCallback(
    (playlists: ParsedPlaylist[]) => {
      startImports(playlists, (imported) => {
        openImported(
          createWithTracks(imported.name, imported.rows, {
            kind: "spotify",
            playlistId: imported.playlistId,
            syncedAt: Date.now(),
            canAdd: imported.canAdd,
            canEditItems: imported.canEditItems,
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

  // The server advances the pointer on its own clock, and its snapshots arrive
  // in bursts. Between two of them a track can run out, so the pointer is
  // settled forward one step here before it is read: the bar rolls onto the
  // next track on time rather than sticking at the end of the last one until
  // the next snapshot lands. This is a view of the pointer, not a decision —
  // the server still owns what actually plays.
  const serverNow = room.serverNow();
  const settled = settleOnce(pointer, sessionQueue[0] ?? null, serverNow);
  const ownerName = nameOf(participants, settled.ownerPubkey);
  const currentItem = currentItemOf(settled);
  const positionMs = settled.itemId === null ? null : positionAt(settled, serverNow);

  const queueSource = queueSourceOf(selection, {
    myPubkey,
    sessionQueue,
    myQueue,
    queueOf,
    broadcasting,
    ownerNameFor: (pubkey) => nameOf(participants, pubkey),
    playlistsFor: (pubkey) => room.playlistsOf(pubkey),
  });

  /**
   * A link says which track, never how long it runs, and a queue item must
   * carry its length. So the lookup happens first and the enqueue follows it.
   * A track whose length will not resolve is dropped rather than queued at
   * zero, which the server would run out instantly.
   */
  function appendTracks(tracks: ParsedTrack[]) {
    void resolveQueueItems(trackMetadata, tracks).then((items) => room.appendToMyQueue(items));
  }

  function replaceTracks(tracks: ParsedTrack[]) {
    void resolveQueueItems(trackMetadata, tracks).then((items) => room.replaceMyQueue(items));
  }

  /**
   * A playlist link dropped on the queue has a different meaning than one
   * dropped on the playlist list: its tracks join the queue directly, rather
   * than becoming a playlist. Nothing is stored, so there is nothing to link
   * and nothing to ask about.
   */
  function importIntoQueue(playlists: ParsedPlaylist[]) {
    startImports(playlists, (imported) => appendTracks(tracksOfRows(imported.rows)));
  }

  /**
   * Album and artist links resolve the same way a playlist does — through the
   * signed-in client, into a static track list — and surface as one status
   * line while they resolve. What happens to the resolved tracks is
   * deliberately not decided here; see `resolveStaticLists`.
   */
  function resolveStaticLists(albums: ParsedAlbum[], artists: ParsedArtist[]) {
    startListResolution(albums, artists, (resolved) => {
      // ENQUEUE STUB — deferred ruling. What these tracks do next is queue
      // semantics, and the duplicate-track decision that governs it
      // (server-dedupes-tracks-while-client-mints-unique-ids, epic
      // queue-semantics) has been deferred by the user, not ruled on.
      // Albums repeat tracks across them and an artist list can hold the
      // same track several times, so enqueueing without that ruling would
      // bake in an answer to a question the room has explicitly left open.
      // When the ruling lands, wire the resolved tracks into the same
      // per-surface policies the playlist path uses.
      void resolved;
    });
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
    if (links.albums.length > 0 || links.artists.length > 0) {
      resolveStaticLists(links.albums, links.artists);
    }
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
          <AttachChip />
          <BroadcastToggle
            broadcasting={broadcasting}
            onToggle={() => room.setBroadcasting(!broadcasting)}
          />
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
            positionMs={positionMs}
            durationMs={settled.durationMs}
            isPaused={settled.isPaused}
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
              onReplaceQueue={replaceTracks}
              onQueueLinks={(links) => handleLinks(links, appendTracks, importIntoQueue)}
              onLinks={(links, onTracks) =>
                handleLinks(
                  links,
                  // A link dropped into a playlist carries no length either,
                  // and a playlist is a place tracks get queued from — so the
                  // same lookup runs here before the rows are made.
                  (tracks) =>
                    void resolvePlaylistTracks(trackMetadata, tracks).then(onTracks),
                  setPendingImport,
                )
              }
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

/** One resolved album or artist list, with the kind that produced it. */
export interface ResolvedList {
  label: "album" | "artist";
  tracks: ParsedTrack[];
}

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
 *
 * `startListResolution` is the same mechanism for album and artist links,
 * which resolve to a static track list through the list service.
 */
function usePlaylistImport(): {
  importStatus: string | null;
  startImports: (playlists: ParsedPlaylist[], onImported: (imported: ImportedPlaylist) => void) => void;
  startListResolution: (
    albums: ParsedAlbum[],
    artists: ParsedArtist[],
    onResolved: (lists: ResolvedList[]) => void,
  ) => void;
} {
  const { playlistService, listService } = useRoomServices();
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const startImports = useCallback(
    (playlists: ParsedPlaylist[], onImported: (imported: ImportedPlaylist) => void) => {
      if (playlists.length === 0) return;
      setImportStatus(
        `Importing ${playlists.length} playlist${playlists.length === 1 ? "" : "s"}...`,
      );

      void Promise.all(
        playlists.map(async (playlist) => {
          const imported = await playlistService.import(playlist.uri);
          onImported(imported);
        }),
      ).then(
        () => setImportStatus(null),
        (error: unknown) => setImportStatus(`Couldn't import that playlist: ${messageOf(error)}`),
      );
    },
    [playlistService],
  );

  const startListResolution = useCallback(
    (albums: ParsedAlbum[], artists: ParsedArtist[], onResolved: (lists: ResolvedList[]) => void) => {
      if (albums.length === 0 && artists.length === 0) return;
      if (!listService) {
        // Album and artist links resolve through the signed-in client, which
        // only the desktop shell can reach. Say so rather than sit silent.
        setImportStatus("Album and artist links can't be resolved here — try the desktop app.");
        return;
      }

      const pending: { label: "album" | "artist"; uri: string }[] = [
        ...albums.map((album) => ({ label: "album" as const, uri: album.uri })),
        ...artists.map((artist) => ({ label: "artist" as const, uri: artist.uri })),
      ];

      // The link kind is visible before the resolve completes, not after: a
      // silent wait is what this status line exists to prevent.
      setImportStatus(`${listLabel(albums.length, artists.length)} — resolving...`);

      void Promise.all(
        pending.map(async (item) => {
          const resolved = await listService.fetch(item.uri);
          return { ...item, tracks: resolved.tracks };
        }),
      ).then(
        (lists) => {
          const total = lists.reduce((sum, list) => sum + list.tracks.length, 0);
          setImportStatus(`${listLabel(albums.length, artists.length)} — ${total} tracks resolved.`);
          onResolved(lists);
        },
        (error: unknown) => {
          const kind = pending.length === 1 ? pending[0].label : "album or artist";
          setImportStatus(`Couldn't resolve that ${kind} link: ${messageOf(error)}`);
        },
      );
    },
    [listService],
  );

  // Clear a failure line on its own rather than leaving it up forever.
  useEffect(() => {
    if (!importStatus?.startsWith("Couldn't")) return;
    const id = setTimeout(() => setImportStatus(null), STATUS_LINGER_MS);
    return () => clearTimeout(id);
  }, [importStatus]);

  return { importStatus, startImports, startListResolution };
}

/**
 * The human name for a set of album and artist links, capitalized for a
 * status line: "Album", "2 albums and 1 artist".
 */
function listLabel(albums: number, artists: number): string {
  const parts: string[] = [];
  if (albums === 1) parts.push("album");
  else if (albums > 1) parts.push(`${albums} albums`);
  if (artists === 1) parts.push("artist");
  else if (artists > 1) parts.push(`${artists} artists`);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return parts.join(" and ");
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The track references out of a fetched playlist's rows, lengths and all. */
function tracksOfRows(rows: PlaylistRow[]): PlaylistTrack[] {
  return rows.map((row) => row.track);
}

/**
 * Re-renders every 500ms while something plays, so the clock and bar move.
 *
 * It carries no time of its own. The position is read from the pointer against
 * the server's clock at render, which is the only clock the pointer is dated
 * in; a local timestamp held here would be the wrong frame.
 */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [active]);
}

/** The playing track lives in the pointer, not in any queue — rebuild a card-shaped view of it. */
function currentItemOf(pointer: PlaybackPointer): QueueItem | null {
  if (!pointer.itemId || !pointer.uri) return null;
  return {
    id: pointer.itemId,
    uri: pointer.uri,
    trackId: pointer.uri.replace("spotify:track:", ""),
    durationMs: pointer.durationMs,
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
