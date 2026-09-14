import { useEffect, useState } from "react";
import { JoinRoom } from "./components/JoinRoom";
import { Onboarding } from "./components/Onboarding";
import { QueueView } from "./components/QueueView";
import { Room } from "./lib/room";
import { SyncDriver } from "./lib/sync-driver";
import { loadIdentity, type StoredIdentity } from "./lib/identity";
import { loadSessionPrefs, saveSessionPrefs } from "./lib/session-prefs";

interface Session {
  roomId: string;
}

/** Null until the on-disk lookup answers; then an identity, or none. */
type IdentityState = { status: "loading" } | { status: "ready"; identity: StoredIdentity | null };

export default function App() {
  const [prefs] = useState(loadSessionPrefs);
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [identity, setIdentity] = useState<IdentityState>({ status: "loading" });

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

  // The room and its driver live and die with the session. Creating them
  // here (not in the join handler) means the cleanup only ever stops the
  // exact instances this effect made, so a re-render cannot kill a live
  // driver.
  useEffect(() => {
    if (!session || publicKey === null) return;
    const newRoom = new Room(session.roomId, { publicKey, username });
    const driver = new SyncDriver(newRoom);
    driver.start();
    setRoom(newRoom);
    return () => {
      driver.stop();
      newRoom.destroy();
      setRoom(null);
    };
  }, [session, publicKey, username]);

  function handleJoin(roomId: string) {
    saveSessionPrefs({ ...prefs, lastRoomId: roomId });
    setSession({ roomId });
  }

  if (identity.status === "loading") return null;
  if (!identity.identity) {
    return (
      <Onboarding onReady={(created) => setIdentity({ status: "ready", identity: created })} />
    );
  }

  if (!session) {
    // The key is the account, so the name comes from the identity, not a form.
    return <JoinRoom username={identity.identity.username} initialRoomId={prefs.lastRoomId} onJoin={handleJoin} />;
  }
  if (!room) return null;
  return <QueueView room={room} roomId={session.roomId} />;
}
