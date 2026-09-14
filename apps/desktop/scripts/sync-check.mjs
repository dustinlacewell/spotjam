// Proves the relay syncs two independent clients end to end:
//   node scripts/sync-check.mjs [wss://relay]
// BroadcastChannel is disabled so same-process clients cannot shortcut the
// server, and an awareness field is set on join so peers see each other
// immediately (a fresh Awareness sits at clock 0, which receivers ignore
// until the 15s heartbeat).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const url = process.argv[2] ?? "wss://yjs.ldlework.com";
const room = `spotjam-synccheck-${Date.now()}`;

const docA = new Y.Doc();
const docB = new Y.Doc();
const provA = new WebsocketProvider(url, room, docA, { disableBc: true });
const provB = new WebsocketProvider(url, room, docB, { disableBc: true });

for (const [name, p] of [["A", provA], ["B", provB]]) {
  p.awareness.setLocalStateField("username", name);
  p.on("status", (e) => console.log(name, "status:", e.status));
  p.on("sync", (s) => console.log(name, "synced:", s));
  p.awareness.on("change", () => console.log(name, "sees", p.awareness.getStates().size, "listener(s)"));
}

const queueB = docB.getArray("queue");
queueB.observe(() => console.log("B sees queue:", JSON.stringify(queueB.toArray())));

setTimeout(() => {
  console.log("A pushes item");
  docA.getArray("queue").push([{ id: "1", addedBy: "A" }]);
}, 3000);

setTimeout(() => {
  const ok = queueB.length === 1 && provA.awareness.getStates().size === 2;
  console.log("RESULT:", ok ? "PASS" : "FAIL");
  provA.destroy();
  provB.destroy();
  process.exit(ok ? 0 : 1);
}, 7000);
