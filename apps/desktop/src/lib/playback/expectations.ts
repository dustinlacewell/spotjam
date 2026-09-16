// expectations — what we are waiting for the player to do, and why.
//
// This is the driver's only memory. Spotify takes a moment to obey: it reports
// the old track for most of a second after a play, the old position after a
// seek. During that moment the difference between "our command has not landed
// yet" and "the user just did something" is exactly this list.
//
// Not everything in it is something we asked for. Spotify ends a track and
// steps into the next one on its own, and that is every bit as predictable as
// a command — it just has no command behind it. A `rollover` is that
// prediction, and holding it in the same list means the rest of the system
// needs no special case for the end of a track: the change is explained because
// something outstanding predicted it, which is the only rule there has ever
// been here.
//
// An expectation leaves the list two ways. It holds — the observation shows
// what was predicted — or its deadline passes, and it counts as a failure the
// caller may act on.

import type { Command, CommandKind } from "./commands.js";
import type { Observation } from "./observation.js";

/**
 * The track is about to end and the player will move by itself.
 *
 * `uri` is where it should land: the head of Spotify's own queue, or null when
 * the queue is empty and we only know it will leave `from` — autoplay, or a
 * stop at the end. `from` is the track it was registered against, which is what
 * makes a null-uri rollover checkable at all.
 */
export interface Rollover {
  kind: "rollover";
  uri: string | null;
  from: string | null;
}

/** What an expectation is waiting on: something we did, or something Spotify will. */
export type Awaited = Command | Rollover;

export interface Expectation {
  what: Awaited;
  issuedAt: number;
  deadline: number;
}

/** How long a transport command is given to show up in what Spotify reports. */
export const TRANSPORT_DEADLINE_MS = 3000;
/** Queue-slot commands are local to the client and answer much faster. */
export const QUEUE_DEADLINE_MS = 1500;
/** How far a seek may land from its target and still count as landed. */
export const SEEK_SLACK_MS = 3000;
/** How long past a track's own end the transition is still expected. */
export const ROLLOVER_SLACK_MS = 1500;

function deadlineFor(kind: CommandKind): number {
  return kind === "set-next" || kind === "clear-queue" ? QUEUE_DEADLINE_MS : TRANSPORT_DEADLINE_MS;
}

export function expectationFor(command: Command, now: number): Expectation {
  return { what: command, issuedAt: now, deadline: now + deadlineFor(command.kind) };
}

/**
 * The transition Spotify is about to make by itself.
 *
 * The deadline is the track's own end as *Spotify* reports it, plus a little.
 * Not our clock: the whole point of this expectation is that the two disagree
 * by a beat, and the player's own remaining time is the only honest estimate of
 * when it will move. A transition that has not happened by then is one that is
 * not coming, and the expectation expires so the driver plays the track itself.
 */
export function rolloverFor(obs: Observation, now: number): Expectation {
  const remaining = Math.max(0, obs.durationMs - obs.positionMs);
  return {
    what: { kind: "rollover", uri: obs.queueHead, from: obs.trackUri },
    issuedAt: now,
    deadline: obs.at + remaining + ROLLOVER_SLACK_MS,
  };
}

/**
 * Has this expectation visibly come true?
 *
 * A seek is the only command that has to allow for time passing: the player
 * keeps moving after it arrives, so the target is compared against where a
 * playing track would be by now. A rollover with no known destination is
 * satisfied by leaving the track it was registered on, whatever it went to.
 */
export function holds(e: Expectation, obs: Observation): boolean {
  switch (e.what.kind) {
    case "play":
      return obs.trackUri === e.what.uri;
    case "pause":
      return obs.isPaused;
    case "resume":
      return !obs.isPaused;
    case "seek": {
      const drifted = obs.isPaused ? 0 : obs.at - e.issuedAt;
      return Math.abs(obs.positionMs - (e.what.positionMs + drifted)) <= SEEK_SLACK_MS;
    }
    case "set-next":
      return obs.queueHead === e.what.uri;
    case "clear-queue":
      return obs.queueHead === null;
    case "rollover":
      return e.what.uri !== null ? obs.trackUri === e.what.uri : obs.trackUri !== e.what.from;
  }
}

/**
 * Splits the list three ways against one reading: still in flight, visibly
 * landed, and out of time. The caller acts on both of the ones that left — a
 * landed command proves its target works, an expired one is a target that may
 * be about to be given up on.
 */
export function prune(
  list: Expectation[],
  obs: Observation,
  now: number,
): { kept: Expectation[]; landed: Expectation[]; expired: Expectation[] } {
  const kept: Expectation[] = [];
  const landed: Expectation[] = [];
  const expired: Expectation[] = [];
  for (const e of list) {
    if (holds(e, obs)) landed.push(e);
    else if (now >= e.deadline) expired.push(e);
    else kept.push(e);
  }
  return { kept, landed, expired };
}

/** Is a command of this kind still outstanding? */
export function pending(list: Expectation[], kind: CommandKind): boolean {
  return list.some((e) => e.what.kind === kind);
}

/**
 * Is this track already on its way onto the player?
 *
 * Either we asked for it and the play has not landed yet, or Spotify is about
 * to step into it by itself. Both mean the same thing to everyone who asks:
 * do not start it, it is coming. A rollover with no known destination promises
 * no particular track, so it answers for none.
 */
export function arriving(list: Expectation[], uri: string | null): boolean {
  return list.some(
    (e) =>
      (e.what.kind === "play" && e.what.uri === uri) ||
      (e.what.kind === "rollover" && e.what.uri !== null && e.what.uri === uri),
  );
}

/** Is a rollover outstanding for this track? One per track is enough. */
export function rolloverPending(list: Expectation[], from: string | null): boolean {
  return list.some((e) => e.what.kind === "rollover" && e.what.from === from);
}
