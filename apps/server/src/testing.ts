// Test support — deterministic stand-ins for the injected edges.
//
// Kept in src so the type checker covers it alongside the code it serves.

import { seal, type CanonicalValue, type Envelope, type Keypair } from "@spotjam/protocol";

import type { Clock, Rng } from "./ports.ts";
import type { TimerHandle, Timers } from "./room-clock.ts";

/** A clock the test moves by hand. */
export class FakeClock implements Clock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  set(ms: number): void {
    this.#now = ms;
  }
}

/**
 * Timers the test fires by hand.
 *
 * Nothing is scheduled with the host, so a suite never waits and never leaves a
 * pending track-end timer holding the process open.
 */
export class FakeTimers implements Timers {
  readonly #pending = new Map<number, { callback: () => void; delayMs: number }>();
  #nextId = 1;

  set(callback: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId++;
    this.#pending.set(id, { callback, delayMs });
    return id;
  }

  clear(handle: TimerHandle): void {
    this.#pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** The delay the newest live timer is waiting out. */
  get pendingDelay(): number | null {
    return [...this.#pending.values()].at(-1)?.delayMs ?? null;
  }

  /** Run the newest live timer, as the host would. */
  fire(): void {
    const entry = [...this.#pending.entries()].at(-1);
    if (entry === undefined) throw new Error("no timer was armed");
    this.#pending.delete(entry[0]);
    entry[1].callback();
  }
}

/**
 * Seeded RNG (mulberry32). Same seed, same sequence, so a shuffled queue has
 * one expected answer instead of a probabilistic one.
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seal a payload as a client would, then render the frame. */
export function frame(
  payload: CanonicalValue,
  identity: Keypair,
  now: number,
): string {
  return JSON.stringify(seal(payload, identity, now));
}

/** Collects what the server sent, in order. */
export class RecordingSocket {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  /** Parsed events, newest last. */
  events<T = unknown>(): T[] {
    return this.sent.map((raw) => JSON.parse(raw) as T);
  }

  last<T = unknown>(): T | undefined {
    return this.events<T>().at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Re-seal an envelope's exact payload under a new nonce is NOT what we want;
 * this returns the same frame twice so a test can prove replay rejection. */
export function repeat(frameJson: string): [string, string] {
  return [frameJson, frameJson];
}

export type { Envelope };
