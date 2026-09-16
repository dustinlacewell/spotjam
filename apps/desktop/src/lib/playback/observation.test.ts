import { describe, expect, it } from "vitest";
import { isAd, observationFrom } from "./observation";

describe("isAd", () => {
  it.each([
    ["spotify:ad:1234", true],
    ["spotify:track:abc", false],
    ["spotify:episode:abc", false],
    [null, false],
  ])("%s -> %s", (uri, expected) => {
    expect(isAd(uri)).toBe(expected);
  });
});

describe("observationFrom", () => {
  it("flattens the bridge answer and stamps the local clock", () => {
    const obs = observationFrom(
      {
        state: {
          trackUri: "spotify:track:a",
          trackName: "A",
          isPaused: false,
          positionMs: 1000,
          durationMs: 200_000,
        },
        queueHead: "spotify:track:b",
      },
      5000,
    );
    expect(obs).toEqual({
      trackUri: "spotify:track:a",
      isPaused: false,
      positionMs: 1000,
      durationMs: 200_000,
      queueHead: "spotify:track:b",
      at: 5000,
    });
  });
});
