import { describe, expect, it } from "vitest";
import type { Desired } from "./desired";
import { expectationFor, type Expectation } from "./expectations";
import type { Observation } from "./observation";
import { reconcile } from "./reconcile";
import { freshStuck, recordExpired, STUCK_AFTER, type StuckState } from "./stuck";

const A = "spotify:track:a";
const B = "spotify:track:b";

function obs(over: Partial<Observation> = {}): Observation {
  return {
    trackUri: A,
    isPaused: false,
    positionMs: 10_000,
    durationMs: 200_000,
    queueHead: null,
    at: 1000,
    ...over,
  };
}

function play(over: Partial<Extract<Desired, { kind: "play" }>> = {}): Desired {
  return {
    kind: "play",
    uri: A,
    positionMs: 10_000,
    durationMs: 200_000,
    paused: false,
    nextUri: null,
    ...over,
  };
}

const flight = (...es: Expectation["command"][]): Expectation[] =>
  es.map((c) => expectationFor(c, 1000));

describe("reconcile — idle", () => {
  it("pauses a playing player and clears its queue slot", () => {
    expect(reconcile({ kind: "idle" }, obs({ queueHead: B }), [])).toEqual([
      { kind: "pause" },
      { kind: "clear-queue" },
    ]);
  });

  it("does nothing to an already idle player", () => {
    expect(reconcile({ kind: "idle" }, obs({ isPaused: true, queueHead: null }), [])).toEqual([]);
  });

  it("does not repeat a pause in flight", () => {
    expect(reconcile({ kind: "idle" }, obs(), flight({ kind: "pause" }))).toEqual([]);
  });

  it("does not repeat a clear in flight", () => {
    const out = reconcile(
      { kind: "idle" },
      obs({ isPaused: true, queueHead: B }),
      flight({ kind: "clear-queue" }),
    );
    expect(out).toEqual([]);
  });
});

describe("reconcile — the wrong track", () => {
  it("plays it", () => {
    expect(reconcile(play({ positionMs: 0 }), obs({ trackUri: B }), [])).toEqual([
      { kind: "play", uri: A },
    ]);
  });

  it("plays it from nothing at all", () => {
    expect(reconcile(play({ positionMs: 0 }), obs({ trackUri: null }), [])).toEqual([
      { kind: "play", uri: A },
    ]);
  });

  it("issues the play alone, however far into the track the room is", () => {
    // A seek in the same breath reaches Spotify while the track is still
    // loading and is lost against nothing — and blocks the drift correction
    // that would have placed it. The placing waits for the track to arrive.
    expect(reconcile(play({ positionMs: 60_000 }), obs({ trackUri: B }), [])).toEqual([
      { kind: "play", uri: A },
    ]);
  });

  it("issues the play alone when the room is paused", () => {
    const out = reconcile(play({ positionMs: 60_000, paused: true }), obs({ trackUri: B }), []);
    expect(out).toEqual([{ kind: "play", uri: A }]);
  });

  it("places the track once it has actually landed", () => {
    // The tick after the play lands: Spotify reports the right track and a real
    // position, and the drift branch puts it on the shared clock.
    const out = reconcile(play({ positionMs: 60_000 }), obs({ trackUri: A, positionMs: 400 }), []);
    expect(out).toEqual([{ kind: "seek", positionMs: 60_000 }]);
  });

  it("waits out the buffer before placing it", () => {
    // A playing track at 0 has not started; seeking fights the load.
    const out = reconcile(play({ positionMs: 60_000 }), obs({ trackUri: A, positionMs: 0 }), []);
    expect(out).toEqual([]);
  });

  it("pauses a freshly landed track, and places it on the next tick", () => {
    // The pause goes alone. The seek follows once the player reports paused,
    // from the drift branch — which retries, so a dropped one is recoverable.
    const playing = obs({ trackUri: A, positionMs: 400, isPaused: false });
    expect(reconcile(play({ positionMs: 60_000, paused: true }), playing, [])).toEqual([
      { kind: "pause" },
    ]);

    const paused = obs({ trackUri: A, positionMs: 400, isPaused: true });
    expect(reconcile(play({ positionMs: 60_000, paused: true }), paused, [])).toEqual([
      { kind: "seek", positionMs: 60_000 },
    ]);
  });

  it("does not seek a paused track that is already in the right place", () => {
    const out = reconcile(
      play({ positionMs: 60_000, paused: true }),
      obs({ trackUri: A, positionMs: 59_000, isPaused: true }),
      [],
    );
    expect(out).toEqual([]);
  });

  it("does not repeat a play in flight", () => {
    const out = reconcile(play(), obs({ trackUri: B }), flight({ kind: "play", uri: A }));
    expect(out).toEqual([]);
  });

  it("still keeps the queue slot right while the play is in flight", () => {
    const out = reconcile(
      play({ nextUri: B }),
      obs({ trackUri: B, queueHead: null }),
      flight({ kind: "play", uri: A }),
    );
    expect(out).toEqual([{ kind: "set-next", uri: B }]);
  });
});

describe("reconcile — the wrong play state", () => {
  it("pauses a player the room has paused", () => {
    expect(reconcile(play({ paused: true }), obs({ isPaused: false }), [])).toEqual([
      { kind: "pause" },
    ]);
  });

  it("resumes a player the room is playing", () => {
    expect(reconcile(play(), obs({ isPaused: true }), [])).toEqual([{ kind: "resume" }]);
  });

  it("resumes alone, and places the player on the next tick", () => {
    const out = reconcile(play({ positionMs: 60_000 }), obs({ isPaused: true, positionMs: 0 }), []);
    expect(out).toEqual([{ kind: "resume" }]);
  });

  it("does not seek once resumed if the player is already there", () => {
    const out = reconcile(
      play({ positionMs: 60_000 }),
      obs({ isPaused: false, positionMs: 59_000 }),
      [],
    );
    expect(out).toEqual([]);
  });

  it("does not repeat a pause in flight", () => {
    const out = reconcile(play({ paused: true }), obs(), flight({ kind: "pause" }));
    expect(out).toEqual([]);
  });

  it("does not repeat a resume in flight", () => {
    const out = reconcile(play(), obs({ isPaused: true }), flight({ kind: "resume" }));
    expect(out).toEqual([]);
  });
});

describe("reconcile — drift", () => {
  it("seeks a player that has fallen off the clock", () => {
    expect(reconcile(play({ positionMs: 60_000 }), obs({ positionMs: 30_000 }), [])).toEqual([
      { kind: "seek", positionMs: 60_000 },
    ]);
  });

  it("leaves a player within the tolerance alone", () => {
    expect(reconcile(play({ positionMs: 60_000 }), obs({ positionMs: 57_500 }), [])).toEqual([]);
  });

  it("treats a playing player at zero as still buffering", () => {
    expect(reconcile(play({ positionMs: 60_000 }), obs({ positionMs: 0 }), [])).toEqual([]);
  });

  it("does not repeat a seek in flight", () => {
    const out = reconcile(
      play({ positionMs: 60_000 }),
      obs({ positionMs: 0.1 }),
      flight({ kind: "seek", positionMs: 60_000 }),
    );
    expect(out).toEqual([]);
  });

  it("places a paused player the room has seeked", () => {
    // A paused room has no drift, but somebody can still seek it — and the
    // pause branch will not do it, so this is the only branch that can.
    const out = reconcile(
      play({ positionMs: 20_000, paused: true }),
      obs({ isPaused: true, positionMs: 60_000 }),
      [],
    );
    expect(out).toEqual([{ kind: "seek", positionMs: 20_000 }]);
  });

  it("places a paused player parked at zero", () => {
    // Paused at 0 is genuinely stopped at the top, not buffering: a room that
    // wants it elsewhere is right, and the buffering guard must not apply.
    const out = reconcile(
      play({ positionMs: 60_000, paused: true }),
      obs({ isPaused: true, positionMs: 0 }),
      [],
    );
    expect(out).toEqual([{ kind: "seek", positionMs: 60_000 }]);
  });

  it("still waits out a buffering playing track at zero", () => {
    const out = reconcile(
      play({ positionMs: 60_000 }),
      obs({ isPaused: false, positionMs: 0 }),
      [],
    );
    expect(out).toEqual([]);
  });
});

describe("reconcile — the queue slot", () => {
  it("fills an empty slot", () => {
    expect(reconcile(play({ nextUri: B }), obs({ queueHead: null }), [])).toEqual([
      { kind: "set-next", uri: B },
    ]);
  });

  it("replaces the wrong track", () => {
    const out = reconcile(play({ nextUri: B }), obs({ queueHead: "spotify:track:c" }), []);
    expect(out).toEqual([{ kind: "set-next", uri: B }]);
  });

  it("clears a slot the room no longer wants filled", () => {
    expect(reconcile(play({ nextUri: null }), obs({ queueHead: B }), [])).toEqual([
      { kind: "clear-queue" },
    ]);
  });

  it("leaves a correct slot alone", () => {
    expect(reconcile(play({ nextUri: B }), obs({ queueHead: B }), [])).toEqual([]);
  });

  it("does not repeat a queue op in flight", () => {
    expect(reconcile(play({ nextUri: B }), obs(), flight({ kind: "set-next", uri: B }))).toEqual([]);
    expect(
      reconcile(play({ nextUri: null }), obs({ queueHead: B }), flight({ kind: "clear-queue" })),
    ).toEqual([]);
  });

  it("is issued alongside a transport command", () => {
    const out = reconcile(play({ positionMs: 0, nextUri: B }), obs({ trackUri: null }), []);
    expect(out).toEqual([{ kind: "play", uri: A }, { kind: "set-next", uri: B }]);
  });
});

describe("reconcile — a track already on its way", () => {
  /** The transition the driver registers as a track runs out. */
  const rolloverTo = (uri: string | null, from: string | null): Expectation => ({
    what: { kind: "rollover", uri, from },
    issuedAt: 900,
    deadline: 99_999,
  });

  it("does not start a track Spotify is about to reach by itself", () => {
    // Our clock settled onto B first. Playing B now starts it, and Spotify's
    // own transition starts it again: twice, from the top, with a stutter.
    const out = reconcile(
      play({ uri: B, positionMs: 0, nextUri: null }),
      obs({ trackUri: A, positionMs: 199_000, durationMs: 200_000, queueHead: B }),
      [rolloverTo(B, A)],
    );
    expect(out).not.toContainEqual({ kind: "play", uri: B });
  });

  it("starts it once the rollover has gone", () => {
    // Expired and dropped: the transition is not coming, so the ordinary path
    // plays the track. Nothing special-cases the end of a track any more.
    const out = reconcile(
      play({ uri: B, positionMs: 0, nextUri: null }),
      obs({ trackUri: A, positionMs: 200_000, durationMs: 200_000, queueHead: B }),
      [],
    );
    expect(out).toContainEqual({ kind: "play", uri: B });
  });

  it("is not held off by a rollover heading somewhere else", () => {
    const out = reconcile(
      play({ uri: B, positionMs: 0, nextUri: null }),
      obs({ trackUri: A, positionMs: 199_000, durationMs: 200_000 }),
      [rolloverTo("spotify:track:zz", A)],
    );
    expect(out).toContainEqual({ kind: "play", uri: B });
  });

  it("is not held off by a rollover that promises no particular track", () => {
    // It only says the player will leave A — not that it will land on B.
    const out = reconcile(
      play({ uri: B, positionMs: 0, nextUri: null }),
      obs({ trackUri: A, positionMs: 199_000, durationMs: 200_000 }),
      [rolloverTo(null, A)],
    );
    expect(out).toContainEqual({ kind: "play", uri: B });
  });

  it("still keeps the queue slot right while a rollover is outstanding", () => {
    const out = reconcile(
      play({ uri: A, positionMs: 199_000, durationMs: 200_000, nextUri: B }),
      obs({ trackUri: A, positionMs: 199_000, durationMs: 200_000, queueHead: null }),
      [rolloverTo(B, A)],
    );
    expect(out).toEqual([{ kind: "set-next", uri: B }]);
  });

  it("does not start a track our own play is still landing", () => {
    const out = reconcile(
      play({ uri: B, positionMs: 0, nextUri: null }),
      obs({ trackUri: A }),
      [expectationFor({ kind: "play", uri: B }, 900)],
    );
    expect(out).toEqual([]);
  });
});

describe("reconcile — adverts", () => {
  const AD = "spotify:ad:1";

  it("leaves the player alone for the whole ad break", () => {
    expect(reconcile(play({ positionMs: 90_000 }), obs({ trackUri: AD, positionMs: 0 }), [])).toEqual(
      [],
    );
  });

  it("does not seek an advert onto the room's clock", () => {
    const out = reconcile(play({ positionMs: 90_000 }), obs({ trackUri: AD, positionMs: 1000 }), []);
    expect(out).toEqual([]);
  });

  it("still keeps the queue slot right during an ad", () => {
    const out = reconcile(play({ nextUri: B }), obs({ trackUri: AD, queueHead: null }), []);
    expect(out).toEqual([{ kind: "set-next", uri: B }]);
  });
});

describe("reconcile — a play target given up on", () => {
  const stuckOnA = (): StuckState => {
    let state = freshStuck();
    for (let i = 0; i < STUCK_AFTER; i += 1) {
      state = recordExpired(state, [{ kind: "play", uri: A }], 1000);
    }
    return state;
  };

  it("issues neither the play nor the seek and pause that ride with it", () => {
    // The seek is the dangerous one: left behind, it moves whatever the user
    // put on instead, every tick, forever.
    const out = reconcile(
      play({ positionMs: 90_000, paused: true }),
      obs({ trackUri: "spotify:track:zz" }),
      [],
      stuckOnA(),
    );
    expect(out).toEqual([]);
  });

  it("still keeps the queue slot right", () => {
    const out = reconcile(
      play({ positionMs: 90_000, nextUri: B }),
      obs({ trackUri: "spotify:track:zz", queueHead: null }),
      [],
      stuckOnA(),
    );
    expect(out).toEqual([{ kind: "set-next", uri: B }]);
  });

  it("issues the group normally for a track that is not stuck", () => {
    const out = reconcile(
      play({ uri: B, positionMs: 90_000 }),
      obs({ trackUri: "spotify:track:zz" }),
      [],
      stuckOnA(),
    );
    expect(out).toContainEqual({ kind: "play", uri: B });
  });
});
