// Proves a deployed spotjam server answers over a real WebSocket:
//   node --experimental-strip-types --import ./src/register-hook.ts \
//     scripts/wss-check.mjs [wss://host]
//
// Walks the whole path a client walks: register, join, broadcast, play a
// track, report a position, and see that position come back in a snapshot.
// The last step is the point -- it is the half that makes playback shared
// rather than each client guessing at its own bar.
//
// Lives inside apps/server so @spotjam/protocol resolves.

import WebSocket from "ws";
import { generateKeypair, seal } from "@spotjam/protocol";

const url = process.argv[2] ?? "wss://yjs.ldlework.com";
const identity = generateKeypair();
const username = `smoke${Date.now().toString().slice(-6)}`;
const roomId = `smoke-${Date.now().toString().slice(-6)}`;
const TRACK = { id: "t1", uri: "spotify:track:t1", trackId: "t1", durationMs: 200_000 };
const SEEK_POSITION_MS = 42_000;

const socket = new WebSocket(url);
const seen = [];
let stage = "greeting";

function send(payload) {
  socket.send(JSON.stringify(seal(payload, identity)));
}

function finish(code, message) {
  console.log(message);
  try {
    socket.close();
  } catch {
    // Already closing; the exit below is what matters.
  }
  process.exit(code);
}

const timer = setTimeout(
  () => finish(1, `TIMEOUT after 20s at stage "${stage}"; saw: ${JSON.stringify(seen)}`),
  20_000,
);
timer.unref?.();

socket.on("open", () => {
  console.log(`socket open: ${url}`);
  send({ type: "register", username });
});

socket.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  seen.push(event.code ? `${event.type}:${event.code}` : event.type);

  if (event.type === "registered") {
    console.log(`registered as ${event.username}`);
    stage = "joined";
    send({ type: "join-room", roomId });
    return;
  }

  if (event.type === "room-state") {
    const { participants, sessionQueue, pointer, serverTime } = event.snapshot;

    if (stage === "joined") {
      console.log(
        `room-state: participants=${participants.length} ` +
          `sessionQueue=${sessionQueue.length} pointer=${JSON.stringify(pointer.itemId)}`,
      );
      stage = "broadcasting";
      send({ type: "set-broadcasting", roomId, broadcasting: true });
      send({ type: "enqueue", roomId, items: [TRACK] });
      send({ type: "skip", roomId });
      return;
    }

    if (stage === "broadcasting" && pointer.itemId === TRACK.id) {
      console.log(`playing: pointer=${pointer.itemId}`);
      stage = "seeked";
      send({ type: "seek", roomId, positionMs: SEEK_POSITION_MS });
      return;
    }

    if (stage === "seeked") {
      // Snapshots arrive for every op, so wait for the one carrying the seek.
      const positionMs = serverTime - pointer.startedAtEpochMs;
      if (Math.abs(positionMs - SEEK_POSITION_MS) > 2_000) return;
      console.log(`seek applied: positionMs=${positionMs}`);
      finish(0, "WSS ROUND-TRIP: PASS");
    }
    return;
  }

  if (event.type === "error") {
    finish(1, `server error at stage "${stage}": ${event.code} - ${event.message}`);
  }
});

socket.on("error", (err) => finish(1, `socket error: ${err.message}`));
