import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import { expectationFor, type Expectation } from "./expectations";
import type { Observation } from "./observation";

const A = "spotify:track:a";
const B = "spotify:track:b";
const AD = "spotify:ad:1";

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

/** The reading a tick later, with the position advanced by the tick. */
function tickLater(prev: Observation, over: Partial<Observation> = {}): Observation {
  return {
    ...prev,
    at: prev.at + 150,
    positionMs: prev.isPaused ? prev.positionMs : prev.positionMs + 150,
    ...over,
  };
}

const playPending: Expectation[] = [expectationFor({ kind: "play", uri: B }, 900)];
const pausePending: Expectation[] = [expectationFor({ kind: "pause" }, 900)];
const resumePending: Expectation[] = [expectationFor({ kind: "resume" }, 900)];
const seekPending: Expectation[] = [expectationFor({ kind: "seek", positionMs: 60_000 }, 900)];

/** The transition the driver predicts as a track runs out. */
function rolloverTo(uri: string | null, from: string | null): Expectation {
  return { what: { kind: "rollover", uri, from }, issuedAt: 900, deadline: 99_999 };
}

describe("classify", () => {
  it("blames nobody with nothing to compare against", () => {
    expect(classify(null, obs({ trackUri: B, isPaused: true, positionMs: 99_999 }), [])).toBe("ok");
  });

  describe("the track changed", () => {
    it("is the user with no explanation", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { trackUri: B, positionMs: 0 }), [])).toBe("user");
    });

    it("is ok while a play is outstanding", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { trackUri: B, positionMs: 0 }), playPending)).toBe(
        "ok",
      );
    });

    it("is ok when an advert starts", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { trackUri: AD, positionMs: 0 }), [])).toBe("ok");
    });

    it("is ok when an advert ends", () => {
      const prev = obs({ trackUri: AD, durationMs: 30_000 });
      expect(classify(prev, tickLater(prev, { trackUri: A, positionMs: 0 }), [])).toBe("ok");
    });

    it("is ok when the previous track ran out — the gapless move", () => {
      const prev = obs({ positionMs: 199_000, durationMs: 200_000 });
      expect(classify(prev, tickLater(prev, { trackUri: B, positionMs: 0 }), [])).toBe("ok");
    });

    it("is the user when the previous track had time left", () => {
      // Far enough from the end that the tick between readings cannot reach it.
      const prev = obs({ positionMs: 120_000, durationMs: 200_000 });
      expect(classify(prev, tickLater(prev, { trackUri: B, positionMs: 0 }), [])).toBe("user");
    });

    it("is ok when a rollover predicted this very transition", () => {
      const prev = obs({ positionMs: 199_000, durationMs: 200_000, at: 1000 });
      const next = obs({ trackUri: B, positionMs: 500, durationMs: 200_000, at: 1150 });
      expect(classify(prev, next, [rolloverTo(B, A)])).toBe("ok");
    });

    it("is ok when a delayed reading straddles a predicted transition", () => {
      // The rollover was registered before observe stalled for three seconds.
      // It is still outstanding when the late reading lands, and it is what
      // explains the move — no clock arithmetic needed.
      const prev = obs({ positionMs: 199_000, durationMs: 200_000, at: 1000 });
      const next = obs({ trackUri: B, positionMs: 500, durationMs: 200_000, at: 4000 });
      expect(classify(prev, next, [rolloverTo(B, A)])).toBe("ok");
    });

    it("is ok when the queue was empty and Spotify chose for itself", () => {
      // A rollover with no destination only promises the player will leave.
      const prev = obs({ positionMs: 199_000, durationMs: 200_000, at: 1000 });
      const next = obs({ trackUri: "spotify:track:zz", positionMs: 0, at: 1150 });
      expect(classify(prev, next, [rolloverTo(null, A)])).toBe("ok");
    });

    it("is the user when the transition went somewhere the rollover did not name", () => {
      // We knew B was queued; the player is on something else, so a person
      // reached for it. `prev` is outside the end window, so the parked-at-the-
      // end backstop does not cover it either.
      const prev = obs({ positionMs: 190_000, durationMs: 200_000, at: 1000 });
      const next = obs({ trackUri: "spotify:track:zz", positionMs: 0, at: 1150 });
      expect(classify(prev, next, [rolloverTo(B, A)])).toBe("user");
    });

    it("is ok when the last reading had already reached the end", () => {
      // The backstop for a transition no rollover was registered for — the
      // reading that would have registered one never arrived. Plain and
      // unprojected: the player was already at the end when we last looked.
      const prev = obs({ positionMs: 200_000, durationMs: 200_000, at: 1000 });
      const next = obs({ trackUri: B, positionMs: 500, durationMs: 200_000, at: 4000 });
      expect(classify(prev, next, [])).toBe("ok");
    });

    it("does not credit a paused track with time it did not play", () => {
      // Paused 2.5s short of the end and left there: the delay moves nothing,
      // so a track change is still somebody's doing.
      const prev = obs({ positionMs: 197_500, durationMs: 200_000, at: 1000, isPaused: true });
      const next = obs({
        trackUri: B,
        positionMs: 500,
        durationMs: 200_000,
        at: 4000,
        isPaused: true,
      });
      expect(classify(prev, next, [])).toBe("user");
    });

    it("is the user when a play for a different track is the only thing in flight", () => {
      // We asked for B; the user put on C. Waving this through would let the
      // next tick re-issue play(B) straight over the top of them.
      const prev = obs({ trackUri: A });
      const next = tickLater(prev, { trackUri: "spotify:track:c", positionMs: 0 });
      expect(classify(prev, next, playPending)).toBe("user");
    });

    it("is ok when the outstanding play is for the track now showing", () => {
      const prev = obs({ trackUri: A });
      const next = tickLater(prev, { trackUri: B, positionMs: 0 });
      expect(classify(prev, next, playPending)).toBe("ok");
    });

    it("does not read a zero duration as having run out", () => {
      const prev = obs({ positionMs: 0, durationMs: 0 });
      expect(classify(prev, tickLater(prev, { trackUri: B }), [])).toBe("user");
    });
  });

  describe("the play state changed", () => {
    it("is the user with no explanation", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { isPaused: true }), [])).toBe("user");
    });

    it("is ok while a pause is outstanding", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { isPaused: true }), pausePending)).toBe("ok");
    });

    it("is ok while a resume is outstanding", () => {
      const prev = obs({ isPaused: true });
      expect(classify(prev, tickLater(prev, { isPaused: false }), resumePending)).toBe("ok");
    });

    it("is ok while a play of this very track is outstanding", () => {
      const prev = obs();
      const playingA: Expectation[] = [expectationFor({ kind: "play", uri: A }, 900)];
      expect(classify(prev, tickLater(prev, { isPaused: true }), playingA)).toBe("ok");
    });

    it("is the user when the outstanding play is for a different track", () => {
      // play(B) is in flight; the user paused A. Waving it through means
      // resuming over them on the next tick.
      const prev = obs();
      expect(classify(prev, tickLater(prev, { isPaused: true }), playPending)).toBe("user");
    });

    it("is ok when the previous track ran out — parking paused at the end", () => {
      const prev = obs({ positionMs: 199_500, durationMs: 200_000 });
      expect(classify(prev, tickLater(prev, { isPaused: true }), [])).toBe("ok");
    });

    it("is the user when they pause in the last moments without the player parking", () => {
      // Near the end is not the same as at the end. A pause here is a finger on
      // the keyboard, and excusing it resumes over them on the next tick.
      // 2s from the end: close enough that the projected `prev` reads as having
      // run out, but the player plainly has not parked.
      const prev = obs({ positionMs: 198_000, durationMs: 200_000, at: 1000 });
      const next = obs({ positionMs: 198_000, durationMs: 200_000, isPaused: true, at: 2600 });
      expect(classify(prev, next, [])).toBe("user");
    });

    it("is ok when the player really did park on the last frame", () => {
      const prev = obs({ positionMs: 199_000, durationMs: 200_000 });
      const next = obs({ positionMs: 200_000, durationMs: 200_000, isPaused: true, at: 1150 });
      expect(classify(prev, next, [])).toBe("ok");
    });

    it("is ok when an advert is involved", () => {
      const prev = obs({ trackUri: AD, durationMs: 30_000 });
      expect(classify(prev, tickLater(prev, { isPaused: true }), [])).toBe("ok");
    });

    it("is ok when an explained track change carried it", () => {
      const prev = obs({ positionMs: 199_500, durationMs: 200_000 });
      const next = tickLater(prev, { trackUri: B, positionMs: 0, isPaused: true });
      expect(classify(prev, next, [])).toBe("ok");
    });

    it("is the user when the track change itself was not explained", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { trackUri: B, isPaused: true }), [])).toBe("user");
    });
  });

  describe("the position moved", () => {
    it("is ok when it advanced by the tick", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev), [])).toBe("ok");
    });

    it("is ok when it stalled for a tick", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { positionMs: prev.positionMs }), [])).toBe("ok");
    });

    it("is ok when a paused track held still", () => {
      const prev = obs({ isPaused: true });
      expect(classify(prev, tickLater(prev), [])).toBe("ok");
    });

    it("is the user on a jump forward", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { positionMs: 60_000 }), [])).toBe("user");
    });

    it("is the user on a jump back", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { positionMs: 0 }), [])).toBe("user");
    });

    it("is the user when a paused track moved", () => {
      const prev = obs({ isPaused: true });
      expect(classify(prev, tickLater(prev, { positionMs: 60_000 }), [])).toBe("user");
    });

    it("is ok while a seek is outstanding", () => {
      const prev = obs();
      expect(classify(prev, tickLater(prev, { positionMs: 60_000 }), seekPending)).toBe("ok");
    });

    it("is ok while a play of this very track is outstanding", () => {
      const prev = obs();
      const playingA: Expectation[] = [expectationFor({ kind: "play", uri: A }, 900)];
      expect(classify(prev, tickLater(prev, { positionMs: 60_000 }), playingA)).toBe("ok");
    });

    it("is the user when the outstanding play is for a different track", () => {
      const prev = obs();
      // play(B) is in flight, but the jump happened on A — our command cannot
      // account for it, so somebody moved the player.
      expect(classify(prev, tickLater(prev, { positionMs: 60_000 }), playPending)).toBe("user");
    });

    it("is not judged when the track changed", () => {
      const prev = obs({ positionMs: 199_000, durationMs: 200_000 });
      expect(classify(prev, tickLater(prev, { trackUri: B, positionMs: 0 }), [])).toBe("ok");
    });

    it("is ok when a track finishes buffering and jumps off zero", () => {
      // play+seek on a join: the uri lands but the position reads 0 for several
      // seconds while it loads — long enough for the seek expectation to
      // expire. The jump when it finally starts is the load, not a person.
      const prev = obs({ positionMs: 0, at: 1000 });
      const next = obs({ positionMs: 60_000, at: 5000 });
      expect(classify(prev, next, [])).toBe("ok");
    });

    it("still judges a paused track sitting at zero", () => {
      // A paused player at 0 is not buffering; it is stopped at the top.
      const prev = obs({ positionMs: 0, at: 1000, isPaused: true });
      const next = obs({ positionMs: 60_000, at: 5000, isPaused: true });
      expect(classify(prev, next, [])).toBe("user");
    });

    it("is the user when an outstanding seek aimed somewhere else", () => {
      // Our seek was for 60s; the player is at 120s. Ours cannot explain that,
      // so somebody else moved it.
      const prev = obs();
      const next = tickLater(prev, { positionMs: 120_000 });
      expect(classify(prev, next, seekPending)).toBe("user");
    });

    it("is the user when the outstanding seek has drifted out of tolerance", () => {
      // A seek issued long ago would only accept a position that has run on
      // with it; this one has not.
      const prev = obs({ positionMs: 10_000, at: 1000 });
      const next = obs({ positionMs: 60_000, at: 30_000 });
      expect(classify(prev, next, seekPending)).toBe("user");
    });

    it("tolerates two seconds of slop", () => {
      const prev = obs();
      const within = tickLater(prev, { positionMs: prev.positionMs + 150 + 2000 });
      const beyond = tickLater(prev, { positionMs: prev.positionMs + 150 + 2001 });
      expect(classify(prev, within, [])).toBe("ok");
      expect(classify(prev, beyond, [])).toBe("user");
    });
  });
});
