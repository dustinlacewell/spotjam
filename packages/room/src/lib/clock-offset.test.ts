import { describe, expect, it } from "vitest";

import { foldSample, offsetOf, serverNow } from "./clock-offset";

describe("foldSample + offsetOf", () => {
  it("takes the first sample whole", () => {
    expect(offsetOf(foldSample(null, 1_000, 400))).toBe(600);
  });

  it("takes a negative first sample whole", () => {
    expect(offsetOf(foldSample(null, 400, 1_000))).toBe(-600);
  });

  it("keeps the largest sample: the least-delayed frame is the least biased", () => {
    const one = foldSample(null, 1_000, 400); // offset sample 600
    const two = foldSample(one, 1_400, 1_000); // sample 400 (a later frame)

    expect(offsetOf(two)).toBe(600);
  });

  it("adopts a larger sample immediately, so a corrected clock is not averaged away", () => {
    const one = foldSample(null, 1_000, 1_000); // sample 0
    const two = foldSample(one, 4_000, 1_000); // sample 3_000

    expect(offsetOf(two)).toBe(3_000);
  });

  it("drops samples older than the window", () => {
    // The window expires by local arrival time: a sample taken 61s ago is out.
    const stale = [{ serverTime: 10_000, localNow: 0 }];
    const window = foldSample(stale, 61_000, 61_000);

    expect(offsetOf(window)).toBe(0);
  });

  it("keeps samples inside the window", () => {
    const kept = [{ serverTime: 17_000, localNow: 12_000 }]; // sample 5_000
    const window = foldSample(kept, 71_000, 71_000);

    expect(offsetOf(window)).toBe(5_000);
  });
});

describe("serverNow", () => {
  it("shifts local time into the server's frame", () => {
    expect(serverNow(600, 1_000)).toBe(1_600);
  });

  it("handles a server clock behind ours", () => {
    expect(serverNow(-600, 1_000)).toBe(400);
  });
});
