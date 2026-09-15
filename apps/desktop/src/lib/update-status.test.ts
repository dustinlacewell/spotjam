import { describe, expect, it } from "vitest";

import {
  DownloadProgress,
  isActionable,
  updateLabel,
  updateTone,
  type UpdateStatus,
} from "./update-status.ts";

describe("updateLabel", () => {
  it.each<[UpdateStatus, string]>([
    [{ state: "checking" }, "Checking…"],
    [{ state: "current", version: "0.1.0" }, "v0.1.0"],
    [{ state: "available", version: "0.1.0", latest: "0.2.0" }, "Update to v0.2.0"],
    [
      { state: "downloading", version: "0.1.0", latest: "0.2.0", percent: 42 },
      "Downloading 42%",
    ],
    [{ state: "installing", version: "0.1.0", latest: "0.2.0" }, "Installing…"],
    [{ state: "restart", version: "0.1.0", latest: "0.2.0" }, "Restart to finish"],
    [{ state: "failed", version: "0.1.0", message: "boom" }, "v0.1.0 — update failed"],
  ])("labels %o", (status, expected) => {
    expect(updateLabel(status)).toBe(expected);
  });

  // A server that sends no content-length must not produce "Downloading null%".
  it("omits the percentage when the total is unknown", () => {
    expect(
      updateLabel({ state: "downloading", version: "0.1.0", latest: "0.2.0", percent: null }),
    ).toBe("Downloading…");
  });
});

describe("isActionable", () => {
  it("is true only where pressing does something", () => {
    expect(isActionable({ state: "available", version: "0.1.0", latest: "0.2.0" })).toBe(true);
    expect(isActionable({ state: "failed", version: "0.1.0", message: "boom" })).toBe(true);

    expect(isActionable({ state: "current", version: "0.1.0" })).toBe(false);
    expect(isActionable({ state: "checking" })).toBe(false);
    expect(
      isActionable({ state: "downloading", version: "0.1.0", latest: "0.2.0", percent: 1 }),
    ).toBe(false);
    expect(isActionable({ state: "installing", version: "0.1.0", latest: "0.2.0" })).toBe(false);
  });
});

describe("updateTone", () => {
  it("stays quiet when there is nothing to do", () => {
    expect(updateTone({ state: "current", version: "0.1.0" })).toBe("muted");
    expect(updateTone({ state: "checking" })).toBe("muted");
  });

  it("draws attention to an update and to the restart that finishes it", () => {
    expect(updateTone({ state: "available", version: "0.1.0", latest: "0.2.0" })).toBe("accent");
    expect(updateTone({ state: "restart", version: "0.1.0", latest: "0.2.0" })).toBe("accent");
  });

  it("marks a failure", () => {
    expect(updateTone({ state: "failed", version: "0.1.0", message: "boom" })).toBe("error");
  });
});

describe("DownloadProgress", () => {
  it("accumulates chunks against the announced total", () => {
    const progress = new DownloadProgress();

    expect(progress.apply({ event: "Started", data: { contentLength: 1000 } })).toBe(0);
    expect(progress.apply({ event: "Progress", data: { chunkLength: 250 } })).toBe(25);
    expect(progress.apply({ event: "Progress", data: { chunkLength: 250 } })).toBe(50);
    expect(progress.apply({ event: "Finished" })).toBe(100);
  });

  it("reports null throughout when no total was announced", () => {
    const progress = new DownloadProgress();

    expect(progress.apply({ event: "Started", data: {} })).toBeNull();
    expect(progress.apply({ event: "Progress", data: { chunkLength: 500 } })).toBeNull();
    expect(progress.apply({ event: "Finished" })).toBeNull();
  });

  // Byte counts that overshoot the announced length must not read past 100%.
  it("clamps at 100", () => {
    const progress = new DownloadProgress();
    progress.apply({ event: "Started", data: { contentLength: 100 } });
    expect(progress.apply({ event: "Progress", data: { chunkLength: 500 } })).toBe(100);
  });

  it("treats a zero-length total as unknown", () => {
    const progress = new DownloadProgress();
    progress.apply({ event: "Started", data: { contentLength: 0 } });
    expect(progress.apply({ event: "Progress", data: { chunkLength: 10 } })).toBeNull();
  });

  it("starts over when a second download begins", () => {
    const progress = new DownloadProgress();
    progress.apply({ event: "Started", data: { contentLength: 100 } });
    progress.apply({ event: "Progress", data: { chunkLength: 100 } });

    expect(progress.apply({ event: "Started", data: { contentLength: 200 } })).toBe(0);
    expect(progress.apply({ event: "Progress", data: { chunkLength: 100 } })).toBe(50);
  });
});
