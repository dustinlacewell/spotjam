// Reusable thin client for the spotjam signaling-server wire protocol,
// for test and debugging scripts that need to speak the protocol directly
// (see docs/desktop/debugging-the-app.md, "Simulating a second peer").
//
// Envelope format, canonicalization and identity come from @spotjam/protocol
// itself, so a script cannot drift from the wire contract the app speaks.
//
// Run scripts that import this from apps/server:
//   node --experimental-strip-types --import ./src/register-hook.ts \
//     scripts/replay-wire-test.mjs
// (the resolve hook is needed because @spotjam/protocol exports TS sources)
//
// WS_URL overrides the target: ws://127.0.0.1:4444 (local dev server) or
// wss://yjs.ldlework.com (deployed).
import WebSocket from "ws";
import {
  canonicalize,
  generateKeypair,
  seal,
  REPLAY_WINDOW_MS,
} from "@spotjam/protocol";

export { canonicalize, generateKeypair, REPLAY_WINDOW_MS };

/**
 * Build a signed wire frame. Returns the JSON string to send over the socket.
 * Timestamp defaults to now; pass a future/past ms to test the replay guard.
 */
export function makeEnvelope(payload, keypair, timestamp = Date.now()) {
  return JSON.stringify(seal(payload, keypair, timestamp));
}

/** Create a fresh ed25519 identity as { keypair, pubkey } (pubkey hex = identity). */
export function makeIdentity() {
  const keypair = generateKeypair();
  return { keypair, pubkey: keypair.publicKey };
}

/**
 * Connect, wrap a socket with a message inbox, and return a client:
 *   send(payload)             — seal and send an op
 *   sendRaw(jsonString)       — send pre-built frames (e.g. replays)
 *   waitFor(pred, label, ms)  — resolve the first inbox message matching pred
 *   handshake({ roomId })     — hello -> register (if needed) -> join-room
 *   close()
 */
export function createWireClient(url, keypair, { log = () => {} } = {}) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  let T0 = Date.now();
  const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    log(`<- ${elapsed()}s ${JSON.stringify(msg).slice(0, 200)}`);
    inbox.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
        break;
      }
    }
  };

  function waitFor(pred, label, timeoutMs = 15000) {
    const found = inbox.find(pred);
    if (found) {
      inbox.length = 0;
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      waiters.push({
        pred,
        resolve: (m) => {
          inbox.length = 0;
          resolve(m);
        },
      });
      setTimeout(() => {
        const idx = waiters.findIndex((w) => w.pred === pred);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
    });
  }

  function sendRaw(json) {
    log(`-> ${elapsed()}s ${json.slice(0, 200)}`);
    ws.send(json);
  }

  function send(payload, timestamp = Date.now()) {
    sendRaw(makeEnvelope(payload, keypair, timestamp));
  }

  async function connect() {
    if (ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    T0 = Date.now();
    log(`connected to ${url}`);
  }

  /** hello -> (unknown-identity -> register) -> join-room -> room-state. */
  async function handshake({ roomId, username = `wire-${Math.random().toString(16).slice(2, 10)}` }) {
    send({ type: "hello" });
    const first = await waitFor(
      (m) => (m.type === "error" && m.code === "unknown-identity") || m.type === "registered",
      "hello response",
    );
    if (first.type === "error") {
      send({ type: "register", username });
      const reg = await waitFor((m) => m.type === "registered" || m.type === "error", "registered");
      if (reg.type !== "registered") throw new Error("register failed: " + JSON.stringify(reg));
    }
    send({ type: "join-room", roomId });
    await waitFor((m) => m.type === "room-state", "room-state after join");
  }

  return {
    ws,
    send,
    sendRaw,
    makeEnvelope: (payload, timestamp) => makeEnvelope(payload, keypair, timestamp),
    waitFor,
    handshake,
    connect,
    close: () => ws.close(),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Step/check harness. Usage:
 *   const { check, finish } = createChecks();
 *   check("name", ok, detail?);
 *   ...
 *   process.exit(finish());   // prints a summary; 0 iff every check passed
 */
export function createChecks(log = console.log) {
  let step = 0;
  const results = [];
  return {
    check(name, ok, detail) {
      step++;
      results.push({ step, name, ok, detail });
      log(`\nSTEP ${step}: ${name} => ${ok ? "PASS" : "FAIL"}${detail ? " (" + detail + ")" : ""}\n`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      log(`\n==== SUMMARY: ${results.length - failed.length}/${results.length} checks passed ====`);
      failed.forEach((f) => log(`FAILED: ${f.name}`));
      return failed.length === 0 ? 0 : 1;
    },
    results,
  };
}
