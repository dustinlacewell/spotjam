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

    it("detaches when the user plays an unrelated track", () => {
      expect(nextControlState(null, playing("spotify:track:mine"), ROOM, NEXT, false)).toBe(
        "detached",
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
        "detached",
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
});
