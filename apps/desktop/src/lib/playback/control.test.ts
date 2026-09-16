import { describe, expect, it } from "vitest";
import type { BridgeState } from "../bridge-state";
import { controlState, type PlayerControlState } from "./control";
import type { Mode } from "./mode";

describe("controlState", () => {
  it.each<[BridgeState | null, Mode, PlayerControlState]>([
    ["ready", "attached", "attached"],
    ["ready", "detached", "detached"],
    ["lost", "attached", "no-spotify"],
    ["booting", "attached", "no-spotify"],
    ["no-spotify", "detached", "no-spotify"],
    ["no-debug-port", "attached", "no-spotify"],
    [null, "attached", "no-spotify"],
  ])("%s + %s -> %s", (bridge, mode, expected) => {
    expect(controlState(bridge, mode)).toBe(expected);
  });
});
