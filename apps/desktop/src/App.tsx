import { useEffect, useState } from "react";
import { BrowseRooms } from "./components/BrowseRooms";
import { JoinRoom } from "./components/JoinRoom";
import { Onboarding } from "./components/Onboarding";
import { QueueView } from "./components/QueueView";
import { Connection, Room } from "./lib/room";
import { SyncDriver } from "./lib/sync-driver";
import { loadIdentity, type StoredIdentity } from "./lib/identity";
import { loadSessionPrefs, saveSessionPrefs } from "./lib/session-prefs";

interface Session {
  roomId: string;
}

/** Which pre-session screen shows: the room-code form, or the live-room list. */
type PreSessionView = "join" | "browse";

/** Null until the on-disk lookup answers; then an identity, or none. */
type IdentityState = { status: "loading" } | { status: "ready"; identity: StoredIdentity | null };

export default function App() {
  const [prefs] = useState(loadSessionPrefs);
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [identity, setIdentity] = useState<IdentityState>({ status: "loading" });
  const [preSessionView, setPreSessionView] = useState<PreSessionView>("join");

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
    const driver = new SyncDriver(newRoom);
    driver.start();
    setRoom(newRoom);
    return () => {
      driver.stop();
      newRoom.destroy();
      setRoom(null);
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
  if (!room) return null;
  return <QueueView room={room} roomId={session.roomId} onLeave={handleLeave} />;
}
