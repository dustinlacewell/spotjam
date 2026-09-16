// desired — what the room says Spotify should be doing right now.
//
// The server advances the pointer on its own clock, but a snapshot is only as
// fresh as the last one that arrived. `settleOnce` closes that gap: a pointer
// whose track has already run out is stepped one place forward, onto the head
// of the session queue, before anything is computed from it. So the client can
// play the next track the moment the old one ends, without waiting for the
// server to say so, and without inventing a different answer than the server's.

import { positionAt, settleOnce, type PlaybackPointer, type SessionEntry } from "@spotjam/protocol";

export type Desired =
  | {
      kind: "play";
      uri: string;
      positionMs: number;
      /** The track's own length, so a position at the very end is recognisable. */
      durationMs: number;
      paused: boolean;
      nextUri: string | null;
    }
  | { kind: "idle" };

/**
 * The desired state at `serverNow` (server-clock ms).
 *
 * `nextUri` is what belongs in Spotify's one-slot queue, so the player moves
 * gaplessly into the right track by itself. When the settle consumed the head
 * of the session queue, the slot holds the entry behind it instead.
 */
export function desiredAt(
  pointer: PlaybackPointer,
  sessionQueue: SessionEntry[],
  serverNow: number,
): Desired {
  const settled = settleOnce(pointer, sessionQueue[0] ?? null, serverNow);
  if (settled.itemId === null || settled.uri === null) return { kind: "idle" };

  const consumed = settled.itemId !== pointer.itemId;
  const nextUri = (consumed ? sessionQueue[1] : sessionQueue[0])?.item.uri ?? null;

  return {
    kind: "play",
    uri: settled.uri,
    positionMs: positionAt(settled, serverNow),
    durationMs: settled.durationMs,
    paused: settled.isPaused,
    nextUri,
  };
}
