import { useEffect, useState } from "react";
import { JoinRoom } from "./components/JoinRoom";
import { QueueView } from "./components/QueueView";
import { Room } from "./lib/room";
import { SyncDriver } from "./lib/sync-driver";
import { loadSessionPrefs, saveSessionPrefs } from "./lib/session-prefs";

interface Session {
  roomId: string;
  username: string;
}

export default function App() {
  const [prefs] = useState(loadSessionPrefs);
  const [session, setSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);

  // The room and its driver live and die with the session. Creating them
  // here (not in the join handler) means the cleanup only ever stops the
  // exact instances this effect made, so a re-render cannot kill a live
  // driver.
  useEffect(() => {
    if (!session) return;
    const newRoom = new Room(session.roomId, { userId: prefs.userId, username: session.username });
    const driver = new SyncDriver(newRoom);
    driver.start();
    setRoom(newRoom);
    return () => {
      driver.stop();
      newRoom.destroy();
      setRoom(null);
    };
  }, [session, prefs.userId]);

  function handleJoin(username: string, roomId: string) {
    saveSessionPrefs({ userId: prefs.userId, username, lastRoomId: roomId });
    setSession({ roomId, username });
  }

  if (!session) {
    return (
      <JoinRoom
        initialUsername={prefs.username}
        initialRoomId={prefs.lastRoomId}
        onJoin={handleJoin}
      />
    );
  }
  if (!room) return null;
  return <QueueView room={room} roomId={session.roomId} username={session.username} />;
}
