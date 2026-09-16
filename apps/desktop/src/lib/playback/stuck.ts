// stuck — a target Spotify will not take, remembered so it stops being asked.
//
// A track that has been pulled from the catalogue, or a region-locked one, never
// starts. The play expectation expires, the next tick sees the same gap and
// issues the same play, and the room wedges there making a request a second for
// as long as the pointer sits on it.
//
// So consecutive expirations of the same target are counted. Past the limit the
// target is stuck and the driver stops issuing it. Any success for that target
// clears the count: a command that landed is proof the target works.
//
// The verdict is not permanent. A target is keyed by what it asks for — a uri,
// a position — so the same verdict would otherwise outlive its own reason: a
// track that failed once because the network was down would stay silent for the
// rest of the session, including when somebody queues it again later. Entries
// therefore expire, and the driver drops the whole set when the pointer moves
// to a different item.

import { targetOf, type Command } from "./commands.js";

/** How many expirations in a row before a target is given up on. */
export const STUCK_AFTER = 5;
/** How long a verdict stands before the target is worth trying again. */
export const STUCK_TTL_MS = 60_000;

interface Failure {
  count: number;
  /** When the most recent expiration happened; the verdict ages from here. */
  at: number;
}

/** Counts per target. Plain data: the driver holds one and replaces it each tick. */
export interface StuckState {
  readonly failures: ReadonlyMap<string, Failure>;
}

export function freshStuck(): StuckState {
  return { failures: new Map() };
}

/**
 * One more expiration for each of these commands' targets.
 *
 * A count that has already aged out starts again from one. Otherwise a target
 * that failed four times an hour ago would be condemned by a single fresh
 * failure, which is not five failures in a row by any reading.
 */
export function recordExpired(
  state: StuckState,
  commands: readonly Command[],
  now: number,
): StuckState {
  if (commands.length === 0) return state;
  const failures = new Map(state.failures);
  for (const command of commands) {
    const target = targetOf(command);
    const previous = live(failures.get(target), now);
    failures.set(target, { count: (previous?.count ?? 0) + 1, at: now });
  }
  return { failures };
}

/** A target that worked is not stuck, whatever it did before. */
export function recordSuccess(state: StuckState, commands: readonly Command[]): StuckState {
  if (commands.length === 0) return state;
  const failures = new Map(state.failures);
  let changed = false;
  for (const command of commands) {
    if (failures.delete(targetOf(command))) changed = true;
  }
  return changed ? { failures } : state;
}

export function isStuck(state: StuckState, command: Command, now: number): boolean {
  const failure = live(state.failures.get(targetOf(command)), now);
  return (failure?.count ?? 0) >= STUCK_AFTER;
}

/** The commands still worth issuing. */
export function dropStuck(
  state: StuckState,
  commands: readonly Command[],
  now: number,
): Command[] {
  return commands.filter((command) => !isStuck(state, command, now));
}

/**
 * The targets currently given up on, for the UI to show. Sorted, so a listener
 * comparing two readings sees a change only when the set really moved.
 */
export function stuckTargets(state: StuckState, now: number): string[] {
  const targets: string[] = [];
  for (const [target, failure] of state.failures) {
    if ((live(failure, now)?.count ?? 0) >= STUCK_AFTER) targets.push(target);
  }
  return targets.sort();
}

/** A record still inside its lifetime, or nothing. */
function live(failure: Failure | undefined, now: number): Failure | undefined {
  if (failure === undefined) return undefined;
  return now - failure.at < STUCK_TTL_MS ? failure : undefined;
}
