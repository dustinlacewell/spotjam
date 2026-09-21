// Wire-protocol live test of the replay guard, built on scripts/wire-client.mjs.
//
// Run from apps/server (WS_URL overrides; default ws://127.0.0.1:4444):
//   node --experimental-strip-types --import ./src/register-hook.ts \
//     scripts/replay-wire-test.mjs
//
// REPLAY_WINDOW_MS = 60_000 (packages/protocol/src/envelope.ts).
//   (1) hello -> register -> join-room
//   (2) enqueue with timestamp ~55s in the future (inside the window) -> accept
//   (3) byte-identical replay of that envelope at arrival+~80s -> reject
//       (nonce held until max(arrival, ts)+60s = ts+60s; pre-c1281c2 code evicted
//        the nonce at arrival+60s and would accept this replay)
//   (4) fresh normal enqueue, byte-identical replay after the window -> reject
import { createWireClient, createChecks, makeIdentity, makeEnvelope, REPLAY_WINDOW_MS, sleep } from "./wire-client.mjs";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:4444";
const ROOM = "replay-guard-wire-test";
const log = console.log;
const { keypair } = makeIdentity();
const client = createWireClient(URL, keypair, { log });
const { check, finish } = createChecks(log);

client.ws.onerror = () => {
  log("ws error");
  process.exit(3);
};

client.connect()
  .then(async () => {
    // (1) handshake
    await client.handshake({ roomId: ROOM });
    check("handshake + join-room", true);

    // (2) future-dated op (~55s ahead, inside the 60s window)
    const item = {
      id: "wire-replay-item-1",
      uri: "spotify:track:replaywiretest1",
      trackId: "replaywiretest1",
      durationMs: 180000,
    };
    const futurePayload = { type: "enqueue", roomId: ROOM, items: [item] };
    const futureEnv = makeEnvelope(futurePayload, keypair, Date.now() + 55_000);
    client.sendRaw(futureEnv);
    let accepted;
    try {
      const err = await client.waitFor((m) => m.type === "error", "unexpected error after future-dated op", 4000);
      accepted = false;
      check("future-dated envelope accepted", false, `server error: ${JSON.stringify(err)}`);
    } catch {
      accepted = true;
    }
    if (accepted) {
      await client.waitFor(
        (m) => m.type === "room-state" && JSON.stringify(m).includes("replaywiretest1"),
        "room-state containing enqueued item",
        10000,
      );
      check("future-dated envelope accepted", true, "ts=+55s, item visible in room-state");
    }

    // (3) byte-identical replay at arrival+~80s: envelope still open (age ~25s
    // of its 60s window) but the nonce must still be spent (held until
    // ts+60s = arrival+115s).
    await sleep(80_000);
    client.sendRaw(futureEnv);
    const replayErr = await client.waitFor((m) => m.type === "error", "replay rejection for byte-identical duplicate");
    check(
      "byte-identical replay at arrival+80s rejected",
      replayErr.code === "replay",
      `error code=${replayErr.code} message=${JSON.stringify(replayErr.message ?? replayErr)}`,
    );

    // (4) fresh normal envelope, replayed after the ordinary window
    const normalPayload = {
      type: "enqueue",
      roomId: ROOM,
      items: [{ id: "wire-replay-item-2", uri: "spotify:track:replaywiretest2", trackId: "replaywiretest2", durationMs: 180000 }],
    };
    const normalEnv = makeEnvelope(normalPayload, keypair);
    client.sendRaw(normalEnv);
    await client.waitFor(
      (m) => m.type === "room-state" && JSON.stringify(m).includes("replaywiretest2"),
      "room-state containing second enqueued item",
      10000,
    );
    log("normal envelope accepted; replaying it after the window…");
    await sleep(REPLAY_WINDOW_MS + 5_000);
    client.sendRaw(normalEnv);
    const staleErr = await client.waitFor((m) => m.type === "error", "post-window replay rejection");
    check(
      "normal envelope replay after window rejected",
      staleErr.code === "stale-envelope" || staleErr.code === "replay",
      `error code=${staleErr.code}`,
    );

    process.exit(finish());
  })
  .catch((e) => {
    log(`FATAL: ${e.message}`);
    process.exit(2);
  });
