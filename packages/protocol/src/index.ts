// @spotjam/protocol — shared wire contract between desktop client and server.
//
// This package owns the message shapes, operation types, and the signing
// envelope. Both sides import from here so the contract cannot drift.
//
// Contents land in follow-up work:
//   identity.ts  — keypair shape, pubkey encoding, sign/verify helpers
//   envelope.ts  — signed message envelope (payload + pubkey + signature)
//   ops.ts       — queue/room operations the client may request
//   events.ts    — room state and events the server broadcasts

export const PROTOCOL_VERSION = 1;
