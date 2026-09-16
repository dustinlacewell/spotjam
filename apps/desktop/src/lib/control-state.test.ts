import { describe, expect, it } from "vitest";
import type { PlaybackPointer } from "@spotjam/protocol";
import { nextControlState, type LocalPlayback } from "./control-state";

const EMPTY: PlaybackPointer = {
  itemId: null,
  ownerPubkey: null,
  uri: null,
  startedAtEpochMs: 0,
  isPaused: false,
  pausedAtOffsetMs: 0,
};

function pointerAt(uri: string, itemId = "item-1"): PlaybackPointer {
  return {
    itemId,
    ownerPubkey: "owner",
    uri,
    startedAtEpochMs: 1000,
    isPaused: false,
    pausedAtOffsetMs: 0,
  };
}

function playing(trackUri: string | null): LocalPlayback {
  return { trackUri, isPaused: false };
}

function paused(trackUri: string | null): LocalPlayback {
  return { trackUri, isPaused: true };
}

const ROOM = pointerAt("spotify:track:room");
const NEXT = "spotify:track:next";
const THIRD_HEAD = "spotify:track:third-head";

describe("nextControlState", () => {
  describe("an empty pointer", () => {
    it("is idle whatever the player does", () => {
      expect(nextControlState(null, playing("spotify:track:mine"), EMPTY, null, false)).toBe("idle");
      expect(nextControlState("following", playing(null), EMPTY, null, true)).toBe("idle");
      expect(nextControlState("detached", playing("x"), EMPTY, null, false)).toBe("idle");
    });
  });

  describe("joining a room that is playing", () => {
    it("follows when the player is already on the pointer's track", () => {
      expect(nextControlState(null, playing(ROOM.uri), ROOM, NEXT, false)).toBe("following");
    });

    it("follows even when the user is playing an unrelated track", () => {
      expect(nextControlState(null, playing("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "following",
      );
    });

    it("follows when the player is paused on an unrelated track", () => {
      expect(nextControlState(null, paused("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "following",
      );
    });

    it("follows when the player has no track", () => {
      expect(nextControlState(null, playing(null), ROOM, NEXT, false)).toBe("following");
    });

    it("follows when the player state cannot be read", () => {
      expect(nextControlState(null, null, ROOM, NEXT, false)).toBe("following");
    });

    it("treats leaving idle the same as a first evaluation", () => {
      expect(nextControlState("idle", playing("spotify:track:mine"), ROOM, NEXT, true)).toBe(
        "following",
      );
      expect(nextControlState("idle", playing(ROOM.uri), ROOM, NEXT, true)).toBe("following");
    });
  });

  describe("while following", () => {
    it("keeps following on the pointer's track", () => {
      expect(nextControlState("following", playing(ROOM.uri), ROOM, NEXT, false)).toBe("following");
    });

    it("keeps following through the gapless move into the queued next track", () => {
      expect(nextControlState("following", playing(NEXT), ROOM, NEXT, false)).toBe("following");
    });

    it("keeps following when the player reports no track", () => {
      expect(nextControlState("following", playing(null), ROOM, NEXT, false)).toBe("following");
    });

    it("keeps following when the player state cannot be read", () => {
      expect(nextControlState("following", null, ROOM, NEXT, false)).toBe("following");
    });

    it("detaches when the user switches to an unrelated track", () => {
      expect(nextControlState("following", playing("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "detached",
      );
    });

    it("detaches even when the unrelated track is paused", () => {
      expect(nextControlState("following", paused("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "detached",
      );
    });
  });

  describe("while detached", () => {
    it("stays detached while the pointer holds still", () => {
      expect(nextControlState("detached", paused("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "detached",
      );
    });

    it("takes the player back at a new item when the user is paused", () => {
      expect(nextControlState("detached", paused("spotify:track:mine"), ROOM, NEXT, true)).toBe(
        "following",
      );
    });

    it("stays detached at a new item while the user still plays", () => {
      expect(nextControlState("detached", playing("spotify:track:mine"), ROOM, NEXT, true)).toBe(
        "detached",
      );
    });

    it("stays detached at a new item when the player cannot be read", () => {
      expect(nextControlState("detached", null, ROOM, NEXT, true)).toBe("detached");
    });

    it("stays detached even when the user drifts onto the pointer's track", () => {
      expect(nextControlState("detached", playing(ROOM.uri), ROOM, NEXT, false)).toBe("detached");
    });
  });

  // The room advancing is the system's own transition, not the user taking the
  // player. At the instant a new item arrives Spotify still reports the old
  // track, and reading that as a detach strands the client: it stops issuing
  // the play, so the track never changes and no progress is reported.
  describe("the pointer advancing to a new item", () => {
    const SECOND = pointerAt("spotify:track:second", "item-2");
    const THIRD = "spotify:track:third";

    it("keeps following while Spotify still reports the track that just ended", () => {
      expect(nextControlState("following", playing(ROOM.uri), SECOND, THIRD, true)).toBe(
        "following",
      );
    });

    it("keeps following when the old track was the one we had queued", () => {
      expect(nextControlState("following", playing(NEXT), SECOND, THIRD, true)).toBe("following");
    });

    it("keeps following when Spotify has already landed on the new track", () => {
      expect(nextControlState("following", playing(SECOND.uri), SECOND, THIRD, true)).toBe(
        "following",
      );
    });

    it("keeps following when the user is paused across the seam", () => {
      expect(nextControlState("following", paused(ROOM.uri), SECOND, THIRD, true)).toBe(
        "following",
      );
    });

    it("still detaches on the next tick if the user really is elsewhere", () => {
      // The seam granted one tick's grace. The pointer now holds still and
      // Spotify is on neither the pointer's track nor the queued one.
      expect(nextControlState("following", playing("spotify:track:mine"), SECOND, THIRD, false)).toBe(
        "detached",
      );
    });
  });

  // The mirror seam: we have said this item is over, and the pointer has not
  // moved yet. Spotify went gapless into the track we had queued, and the
  // server may consume that head into the new item before it pushes the
  // pointer, leaving the player on a track neither value names.
  describe("waiting for the server to answer an end we reported", () => {
    it("keeps following while the player sits on a head the queue has moved past", () => {
      expect(nextControlState("following", playing(NEXT), ROOM, THIRD_HEAD, false, true)).toBe(
        "following",
      );
    });

    it("keeps following even where the player is somewhere else entirely", () => {
      // We put it there. Only a pointer that has moved ends the grace.
      expect(
        nextControlState("following", playing("spotify:track:mine"), ROOM, NEXT, false, true),
      ).toBe("following");
    });

    it("detaches as usual once no end is outstanding", () => {
      expect(nextControlState("following", playing(NEXT), ROOM, THIRD_HEAD, false, false)).toBe(
        "detached",
      );
    });

    it("grants no grace to a player the user already took", () => {
      expect(
        nextControlState("detached", playing("spotify:track:mine"), ROOM, NEXT, false, true),
      ).toBe("detached");
    });
  });

  // What the seam grace costs, pinned rather than fixed. A user who takes the
  // player in the same tick the room advances is followed for one tick: the
  // room's track plays over theirs. It is the deliberate trade — reading that
  // tick as a detach strands every client the room really did move, which is
  // the far commoner case — and the next tick detaches for real.
  describe("a user who takes the player exactly at a seam", () => {
    const SECOND = pointerAt("spotify:track:second", "item-2");

    it("is followed for the one tick the pointer moved on", () => {
      expect(nextControlState("following", playing("spotify:track:mine"), SECOND, NEXT, true)).toBe(
        "following",
      );
    });

    it("has the player back on the very next tick", () => {
      expect(nextControlState("following", playing("spotify:track:mine"), SECOND, NEXT, false)).toBe(
        "detached",
      );
    });

    it("is never taken back from while it plays, however the room advances", () => {
      // The reported worry: a genuinely detached user losing their player at
      // the room's next advance. `reclaimed` only ever takes back a player
      // that is paused, so a playing user keeps it across every seam.
      expect(nextControlState("detached", playing("spotify:track:mine"), SECOND, NEXT, true)).toBe(
        "detached",
      );
      expect(nextControlState("detached", playing(SECOND.uri), SECOND, NEXT, true)).toBe(
        "detached",
      );
    });
  });
});
