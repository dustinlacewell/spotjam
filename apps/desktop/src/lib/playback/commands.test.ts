import { describe, expect, it } from "vitest";
import { targetOf, type Command } from "./commands";

describe("targetOf", () => {
  it.each<[Command, string]>([
    [{ kind: "play", uri: "spotify:track:a" }, "play:spotify:track:a"],
    [{ kind: "seek", positionMs: 4200 }, "seek:4200"],
    [{ kind: "pause" }, "pause"],
    [{ kind: "resume" }, "resume"],
    [{ kind: "set-next", uri: "spotify:track:b" }, "set-next:spotify:track:b"],
    [{ kind: "clear-queue" }, "clear-queue"],
  ])("%o -> %s", (command, expected) => {
    expect(targetOf(command)).toBe(expected);
  });

  it("separates plays of different tracks", () => {
    expect(targetOf({ kind: "play", uri: "spotify:track:a" })).not.toBe(
      targetOf({ kind: "play", uri: "spotify:track:b" }),
    );
  });
});
