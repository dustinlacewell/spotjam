import { describe, expect, it } from "vitest";
import { nextMode, type Mode, type ModeEvent } from "./mode";

describe("nextMode", () => {
  it.each<[Mode, ModeEvent, Mode]>([
    ["attached", "attach", "attached"],
    ["attached", "detach", "detached"],
    ["attached", "user-took-player", "detached"],
    ["detached", "attach", "attached"],
    ["detached", "detach", "detached"],
    ["detached", "user-took-player", "detached"],
  ])("%s + %s -> %s", (mode, event, expected) => {
    expect(nextMode(mode, event)).toBe(expected);
  });
});
