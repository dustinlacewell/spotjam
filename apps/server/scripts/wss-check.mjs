// Proves a deployed spotjam server answers over a real WebSocket:
//   node --experimental-strip-types --import ./src/register-hook.ts \
//     scripts/wss-check.mjs [wss://host]
//
// Registers a throwaway identity, joins a room, and asserts a snapshot comes
// back. Lives inside apps/server so @spotjam/protocol resolves.

import WebSocket from "ws";
import { generateKeypair, seal } from "@spotjam/protocol";

const url = process.argv[2] ?? "wss://yjs.ldlework.com";
const identity = generateKeypair();
const username = `smoke${Date.now().toString().slice(-6)}`;
const roomId = `smoke-${Date.now().toString().slice(-6)}`;

const socket = new WebSocket(url);
const seen = [];

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
  () => finish(1, `TIMEOUT after 20s; saw: ${JSON.stringify(seen)}`),
  20_000,
);
timer.unref?.();

socket.on("open", () => {
  console.log(`socket open: ${url}`);
  socket.send(JSON.stringify(seal({ type: "register", username }, identity)));
});

socket.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  seen.push(event.code ? `${event.type}:${event.code}` : event.type);

  if (event.type === "registered") {
    console.log(`registered as ${event.username}`);
    socket.send(JSON.stringify(seal({ type: "join-room", roomId }, identity)));
    return;
  }

  if (event.type === "room-state") {
    const { participants, sessionQueue, pointer } = event.snapshot;
    console.log(
      `room-state: participants=${participants.length} ` +
        `sessionQueue=${sessionQueue.length} pointer=${JSON.stringify(pointer.itemId)}`,
    );
    finish(0, "WSS ROUND-TRIP: PASS");
    return;
  }

  if (event.type === "error") {
    finish(1, `server error: ${event.code} - ${event.message}`);
  }
});

socket.on("error", (err) => finish(1, `socket error: ${err.message}`));
