import { useEffect, useMemo, useState } from "react";
import { BrowseRooms } from "./components/BrowseRooms";
import { JoinRoom } from "./components/JoinRoom";
import { Onboarding } from "./components/Onboarding";
import { SpotifyGate } from "./components/SpotifyGate";
import {
  QueueView,
  RoomServicesProvider,
  type PlayerControlState,
  type RoomServices,
} from "@spotjam/room";
import { Connection, Room } from "./lib/room";
import { PlaybackDriver } from "./lib/playback/driver";
import { controlState } from "./lib/playback/control";
import { loadIdentity, type StoredIdentity } from "./lib/identity";
import { loadSessionPrefs, saveSessionPrefs } from "./lib/session-prefs";
import { tauriTrackMetadata } from "./lib/track-metadata";
import { tauriPlaylistService } from "./lib/playlist-import";
import { tauriBridgeState, type BridgeState } from "./lib/bridge-state";

interface Session {
  roomId: string;
}

/** Which pre-session screen shows: the room-code form, or the live-room list. */
type PreSessionView = "join" | "browse";

/** Null until the on-disk lookup answers; then an identity, or none. */
type IdentityState = { status: "loading" } | { status: "ready"; identity: StoredIdentity | null };

export default function App() {
  return <Screens />;
}

/**
 * What @spotjam/room asks of its surroundings, answered by the desktop shell.
 *
 * The control state the room reads is two facts at once — is there a client,
 * and are we driving it — so the subscription listens to both sources and
 * re-sends the combination whenever either moves.
 */
function useServices(driver: PlaybackDriver | null): RoomServices {
  return useMemo(
    () => ({
      trackMetadata: tauriTrackMetadata,
      playlistService: tauriPlaylistService,
      playerControl: driver
        ? {
            subscribe: (listener: (control: PlayerControlState) => void) => {
              let bridge: BridgeState | null = null;
              let mode = driver.mode();
              let last: PlayerControlState | null = null;
              const emit = () => {
                const next = controlState(bridge, mode);
                if (next === last) return;
                last = next;
                listener(next);
              };
              const offBridge = tauriBridgeState.subscribe((state) => {
                bridge = state;
                emit();
              });
              const offMode = driver.onModeChange((next) => {
                mode = next;
                emit();
              });
              return () => {
                offBridge();
                offMode();
              };
            },
            attach: () => driver.attach(),
            detach: () => driver.detach(),
          }
        : undefined,
    }),
    [driver],
  );
}

/**
 * Every screen resolves track metadata — the browser's room rows as much as the
 * joined room — so the services provider sits above all of them. The player
 * control is the one service that needs a live driver, and there is none before
 * a room is joined: until then it is simply absent, and the room UI reads that
 * as a shell with no local player to report on.
 */
function Screens() {
  const [prefs] = useState(loadSessionPrefs);
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [driver, setDriver] = useState<PlaybackDriver | null>(null);
  const [identity, setIdentity] = useState<IdentityState>({ status: "loading" });
  const [preSessionView, setPreSessionView] = useState<PreSessionView>("join");
  const services = useServices(driver);

  // The identity lives on disk, so the first render cannot know whether one
  // exists. Until this answers, showing either onboarding or the app would be
  // a guess.
  useEffect(() => {
    let cancelled = false;
    void loadIdentity().then((found) => {
      if (!cancelled) setIdentity({ status: "ready", identity: found });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stored = identity.status === "ready" ? identity.identity : null;
  const publicKey = stored?.publicKey ?? null;
  const username = stored?.username ?? "";

  // The connection is the app's one authenticated line to the server. It
  // starts the moment an identity exists — before any room is chosen, so the
  // join screen can browse live rooms — and lives for as long as that
  // identity does.
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => {
    if (publicKey === null) return;
    const conn = new Connection({ publicKey, username });
    setConnection(conn);
    return () => {
      conn.destroy();
      setConnection(null);
    };
  }, [publicKey, username]);

  // The room lives and dies with the session, layered on the app-wide
  // connection. Creating it here (not in the join handler) means the cleanup
  // only ever stops the exact instance this effect made, so a re-render
  // cannot kill a live driver.
  useEffect(() => {
    if (!session || connection === null) return;
    const newRoom = new Room(connection, session.roomId);
    const newDriver = new PlaybackDriver(newRoom);
    newDriver.start();
    setRoom(newRoom);
    setDriver(newDriver);
    return () => {
      newDriver.stop();
      newRoom.destroy();
      setRoom(null);
      setDriver(null);
    };
  }, [session, connection]);

  function handleJoin(roomId: string) {
    saveSessionPrefs({ ...prefs, lastRoomId: roomId });
    setSession({ roomId });
  }

  // Leaving a room returns to the browser, not the join form: the user came
  // from browsing live rooms as often as typing a code, and the browser is
  // one click from either.
  function handleLeave() {
    setSession(null);
    setPreSessionView("browse");
  }

  function screen() {
    if (identity.status === "loading") return null;
    if (!identity.identity) {
      return (
        <Onboarding onReady={(created) => setIdentity({ status: "ready", identity: created })} />
      );
    }

    if (!session) {
      if (connection === null) return null;
      if (preSessionView === "browse") {
        return (
          <BrowseRooms
            connection={connection}
            onJoin={handleJoin}
            onBack={() => setPreSessionView("join")}
          />
        );
      }
      // The key is the account, so the name comes from the identity, not a form.
      return (
        <JoinRoom
          connection={connection}
          username={identity.identity.username}
          initialRoomId={prefs.lastRoomId}
          onJoin={handleJoin}
          onBrowse={() => setPreSessionView("browse")}
        />
      );
    }
    if (!room || !driver) return null;
    return (
      <SpotifyGate source={tauriBridgeState} driver={driver}>
        <QueueView room={room} roomId={session.roomId} onLeave={handleLeave} />
      </SpotifyGate>
    );
  }

  return <RoomServicesProvider services={services}>{screen()}</RoomServicesProvider>;
}
