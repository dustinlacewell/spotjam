import { useEffect, useMemo } from "react";
import {
  MockRoom,
  QueueView,
  RoomServicesProvider,
  type MockRoomSeed,
  type RoomServices,
  type TrackInfo,
} from "@spotjam/room";
import type { QueueItem } from "@spotjam/protocol";
import styles from "./RoomPreview.module.css";

/**
 * The live demo on the marketing page: the real room screen, driven by an
 * in-memory room. Everything a visitor clicks — pause, seek, skip, reorder —
 * runs the same code the desktop app runs.
 */

function uri(trackId: string): `spotify:track:${string}` {
  return `spotify:track:${trackId}`;
}

/** Track lengths in ms, by track id. The room advances on these. */
const LENGTHS_MS: Record<string, number> = {
  "0wXuerDYiBnERgIpbb3JBR": 327_000,
  "6QgjcU0zLnzq5OrUoSZ3OK": 163_000,
  "3FtYbEfBqAlGO46NUDQSAt": 229_000,
  "2ewpiHmQSLEjDdH5ClJp3g": 172_000,
  "0VjIjW4GlUZAMYd2vXMi3b": 200_000,
  "3KkXRkHbMCARz0aVfEt68P": 158_000,
  "7ouMYWpwJ422jRcDASZB7P": 366_000,
  "1mea3bSkSGXuIRvnydlB5b": 242_000,
  "2takcwOaAZWiXQijPHIx7B": 241_000,
  "4uLU6hMCjMI75M1A2tKUQC": 213_000,
  "5ChkMS8OtdzJeqyybCc9R5": 294_000,
  "1BxfuPKGuaTgP7aM0Bbdwr": 178_000,
  "3z8h0TU7ReDPLIbEnYhWZb": 354_000,
};

function item(id: string, trackId: string): QueueItem {
  return { id, uri: uri(trackId), trackId, durationMs: LENGTHS_MS[trackId] ?? 0 };
}

const TRACKS: Record<string, Omit<TrackInfo, "durationMs">> = {
  [uri("0wXuerDYiBnERgIpbb3JBR")]: {
    title: "Redbone",
    artist: "Childish Gambino",
    thumbnailUrl: null,
  },
  [uri("6QgjcU0zLnzq5OrUoSZ3OK")]: {
    title: "Feel It Still",
    artist: "Portugal. The Man",
    thumbnailUrl: null,
  },
  [uri("3FtYbEfBqAlGO46NUDQSAt")]: {
    title: "Electric Feel",
    artist: "MGMT",
    thumbnailUrl: null,
  },
  [uri("2ewpiHmQSLEjDdH5ClJp3g")]: {
    title: "Sunflower",
    artist: "Rex Orange County",
    thumbnailUrl: null,
  },
  [uri("0VjIjW4GlUZAMYd2vXMi3b")]: {
    title: "Blinding Lights",
    artist: "The Weeknd",
    thumbnailUrl: null,
  },
  [uri("3KkXRkHbMCARz0aVfEt68P")]: {
    title: "Sunflower",
    artist: "Post Malone, Swae Lee",
    thumbnailUrl: null,
  },
  [uri("7ouMYWpwJ422jRcDASZB7P")]: {
    title: "Knights of Cydonia",
    artist: "Muse",
    thumbnailUrl: null,
  },
  [uri("1mea3bSkSGXuIRvnydlB5b")]: {
    title: "Viva La Vida",
    artist: "Coldplay",
    thumbnailUrl: null,
  },
  [uri("2takcwOaAZWiXQijPHIx7B")]: {
    title: "Time After Time",
    artist: "Cyndi Lauper",
    thumbnailUrl: null,
  },
  [uri("4uLU6hMCjMI75M1A2tKUQC")]: {
    title: "Never Gonna Give You Up",
    artist: "Rick Astley",
    thumbnailUrl: null,
  },
  [uri("5ChkMS8OtdzJeqyybCc9R5")]: {
    title: "Billie Jean",
    artist: "Michael Jackson",
    thumbnailUrl: null,
  },
  [uri("1BxfuPKGuaTgP7aM0Bbdwr")]: {
    title: "Cruel Summer",
    artist: "Taylor Swift",
    thumbnailUrl: null,
  },
  [uri("3z8h0TU7ReDPLIbEnYhWZb")]: {
    title: "Bohemian Rhapsody",
    artist: "Queen",
    thumbnailUrl: null,
  },
};

const ME = "dustin-pubkey";

const SEED: MockRoomSeed = {
  myPubkey: ME,
  participants: [
    {
      pubkey: ME,
      username: "dustin",
      broadcasting: true,
      queue: [
        item("dustin-1", "0wXuerDYiBnERgIpbb3JBR"),
        item("dustin-2", "3FtYbEfBqAlGO46NUDQSAt"),
        item("dustin-3", "1mea3bSkSGXuIRvnydlB5b"),
      ],
    },
    {
      pubkey: "kai-pubkey",
      username: "kai",
      broadcasting: true,
      queue: [
        item("kai-1", "6QgjcU0zLnzq5OrUoSZ3OK"),
        item("kai-2", "0VjIjW4GlUZAMYd2vXMi3b"),
        item("kai-3", "7ouMYWpwJ422jRcDASZB7P"),
        item("kai-4", "5ChkMS8OtdzJeqyybCc9R5"),
      ],
    },
    {
      pubkey: "sam-pubkey",
      username: "sam",
      broadcasting: false,
      queue: [
        item("sam-1", "2ewpiHmQSLEjDdH5ClJp3g"),
        item("sam-2", "2takcwOaAZWiXQijPHIx7B"),
      ],
    },
    {
      pubkey: "mira-pubkey",
      username: "mira",
      broadcasting: true,
      queue: [
        item("mira-1", "3KkXRkHbMCARz0aVfEt68P"),
        item("mira-2", "1BxfuPKGuaTgP7aM0Bbdwr"),
        item("mira-3", "3z8h0TU7ReDPLIbEnYhWZb"),
        item("mira-4", "4uLU6hMCjMI75M1A2tKUQC"),
      ],
    },
  ],
  playing: { itemId: "dustin-1", durationMs: 327_000, positionMs: 102_000 },
};

const SERVICES: RoomServices = {
  trackMetadata: {
    resolve: (trackUri) => {
      const info = TRACKS[trackUri];
      if (!info) return Promise.resolve(null);
      const trackId = trackUri.replace("spotify:track:", "");
      return Promise.resolve({ ...info, durationMs: LENGTHS_MS[trackId] ?? 0 });
    },
  },
  playlistService: {
    import: () => Promise.reject(new Error("playlist import is off in this preview")),
    addTracks: () => Promise.reject(new Error("playlist editing is off in this preview")),
    removeRows: () => Promise.reject(new Error("playlist editing is off in this preview")),
    moveRow: () => Promise.reject(new Error("playlist editing is off in this preview")),
  },
};

function noop() {}

export function RoomPreview() {
  const room = useMemo(() => new MockRoom(SEED), []);
  useEffect(() => () => room.destroy(), [room]);

  return (
    <section className={styles.section}>
      <div className={styles.window}>
        <RoomServicesProvider services={SERVICES}>
          <QueueView room={room} roomId="fri-night" onLeave={noop} />
        </RoomServicesProvider>
      </div>
    </section>
  );
}
