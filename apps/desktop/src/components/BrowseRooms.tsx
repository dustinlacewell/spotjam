import { useEffect, useState } from "react";
import type { RoomSummary } from "@spotjam/protocol";
import type { Connection } from "../lib/connection";
import { formatUptime } from "../lib/format-uptime";
import { useTrackMetadata } from "../lib/use-track-metadata";
import type { TrackMetadata } from "../lib/track-metadata";
import { RoomDetailPane } from "./RoomDetailPane";
import { useLiveRooms } from "./use-live-rooms";
import { useNow } from "./use-now";
import styles from "./BrowseRooms.module.css";

/** Uptime is measured in minutes, so half a minute is a fine enough tick. */
const UPTIME_TICK_MS = 30_000;

export function BrowseRooms({
  connection,
  onJoin,
  onBack,
}: {
  connection: Connection;
  onJoin: (roomId: string) => void;
  onBack: () => void;
}) {
  const rooms = useLiveRooms(connection);
  const [newRoomId, setNewRoomId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const now = useNow(UPTIME_TICK_MS);

  // A room that closes while selected would otherwise leave the detail pane
  // watching something the server no longer has.
  const selected = rooms.find((room) => room.roomId === selectedRoomId) ?? null;
  useEffect(() => {
    if (selectedRoomId !== null && selected === null) setSelectedRoomId(null);
  }, [selectedRoomId, selected]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.mark}>spotjam</div>
        <div className={styles.headerRight}>
          <button type="button" className={styles.backButton} onClick={onBack}>
            ← Back
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.listPane}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>Live rooms</h1>
            <NewRoomSlot value={newRoomId} onChange={setNewRoomId} onCreate={onJoin} />
          </div>

          {rooms.length === 0 ? (
            <div className={styles.empty}>No rooms are live right now.</div>
          ) : (
            <>
              <div className={styles.columns}>
                <span>Room</span>
                <span>Now playing</span>
                <span>Up</span>
                <span>Users</span>
              </div>
              <div className={styles.scroll}>
                <ul className={styles.roomList}>
                  {rooms.map((room) => (
                    <li key={room.roomId}>
                      <RoomRow
                        room={room}
                        now={now}
                        isSelected={room.roomId === selected?.roomId}
                        onSelect={setSelectedRoomId}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        <RoomDetailPane connection={connection} room={selected} onJoin={onJoin} />
      </div>
    </div>
  );
}

/**
 * The "+ New room" button and the form it opens into, in one fixed-height box.
 *
 * The two states have different natural heights, and the title row is the only
 * thing holding the list's top edge in place. A fixed slot keeps the swap from
 * nudging every row below it.
 */
function NewRoomSlot({
  value,
  onChange,
  onCreate,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  onCreate: (roomId: string) => void;
}) {
  return (
    <div className={styles.newRoomSlot}>
      {value === null ? (
        <button type="button" className={styles.newRoomButton} onClick={() => onChange("")}>
          + New room
        </button>
      ) : (
        <form
          className={styles.newRoomForm}
          onSubmit={(e) => {
            e.preventDefault();
            const id = value.trim().toLowerCase();
            if (id !== "") onCreate(id);
          }}
        >
          <input
            className={styles.newRoomInput}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Room name"
            autoFocus
            spellCheck={false}
            onBlur={() => {
              if (value.trim() === "") onChange(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onChange(null);
            }}
          />
          <button
            type="submit"
            className={styles.newRoomSubmit}
            disabled={value.trim() === ""}
          >
            Create
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Room name while metadata is still loading, so a slow or failed lookup never
 * shows a bare "…" — the trailing slot below simply stays empty until then.
 */
function trackTitle(room: RoomSummary, metadata: TrackMetadata | null): string {
  if (room.trackUri === null) return "Nothing playing";
  return metadata?.title ?? room.trackUri.replace("spotify:track:", "");
}

function RoomRow({
  room,
  now,
  isSelected,
  onSelect,
}: {
  room: RoomSummary;
  now: number;
  isSelected: boolean;
  onSelect: (roomId: string) => void;
}) {
  // Always called, per the rules of hooks; the hook itself no-ops on "".
  const metadata = useTrackMetadata(room.trackUri ?? "");
  const nowPlaying = room.trackUri === null ? null : metadata;

  return (
    <button
      type="button"
      className={isSelected ? styles.roomRowSelected : styles.roomRow}
      onClick={() => onSelect(room.roomId)}
    >
      <span className={styles.roomRowName}>{room.roomId}</span>
      <span className={styles.roomRowTrack}>
        <span className={styles.roomRowArt}>
          {nowPlaying?.thumbnailUrl && <img src={nowPlaying.thumbnailUrl} alt="" />}
        </span>
        <span className={styles.roomRowTrackInfo}>
          <span className={styles.roomRowTrackTitle}>{trackTitle(room, nowPlaying)}</span>
          {nowPlaying?.artist && (
            <span className={styles.roomRowTrackArtist}>{nowPlaying.artist}</span>
          )}
        </span>
      </span>
      <span className={styles.roomRowUptime}>
        {formatUptime(room.createdAtEpochMs, now)}
      </span>
      <span className={styles.roomRowCount}>{room.listeners}</span>
    </button>
  );
}
