import { describe, expect, it } from "vitest";

import {
  mergeManifest,
  parseUpdate,
  type ReleaseManifest,
  type ManifestUpdate,
} from "./release-manifest.ts";

const WINDOWS = { url: "https://example.test/spotjam.msi.zip", signature: "sig-win" };
const MAC = { url: "https://example.test/spotjam.app.tar.gz", signature: "sig-mac" };
const LINUX = { url: "https://example.test/spotjam.AppImage.tar.gz", signature: "sig-linux" };

function update(over: Partial<ManifestUpdate> = {}): ManifestUpdate {
  return { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS }, ...over };
}

describe("parseUpdate", () => {
  it("accepts a well-formed post", () => {
    expect(parseUpdate({ version: "0.2.0", platforms: { "darwin-aarch64": MAC } })).toEqual({
      version: "0.2.0",
      platforms: { "darwin-aarch64": MAC },
    });
  });

  it("keeps pub_date and notes when given", () => {
    const parsed = parseUpdate({
      version: "0.2.0",
      pub_date: "2026-01-01T00:00:00Z",
      notes: "fixes",
      platforms: { "linux-x86_64": LINUX },
    });
    expect(parsed).toMatchObject({ pub_date: "2026-01-01T00:00:00Z", notes: "fixes" });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["a missing version", { platforms: { "linux-x86_64": LINUX } }],
    ["an empty version", { version: "", platforms: { "linux-x86_64": LINUX } }],
    ["no platforms at all", { version: "0.2.0" }],
    ["an empty platform map", { version: "0.2.0", platforms: {} }],
    ["an unknown platform key", { version: "0.2.0", platforms: { "plan9-x86_64": LINUX } }],
    ["a missing signature", { version: "0.2.0", platforms: { "linux-x86_64": { url: "u" } } }],
    [
      "an empty url",
      { version: "0.2.0", platforms: { "linux-x86_64": { url: "", signature: "s" } } },
    ],
  ])("refuses %s", (_label, body) => {
    expect(parseUpdate(body)).toBeNull();
  });

  // tauri-action emits a bundle-suffixed key beside each bare one, so a real
  // release document carries both forms.
  it.each([
    "darwin-x86_64-app",
    "darwin-aarch64-app",
    "linux-x86_64-appimage",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "windows-x86_64-nsis",
  ])("accepts the bundle-suffixed key %s", (key) => {
    const parsed = parseUpdate({ version: "0.1.0", platforms: { [key]: LINUX } });
    expect(parsed?.platforms[key]).toEqual(LINUX);
  });

  it("takes a whole real release document", () => {
    const parsed = parseUpdate({
      version: "0.1.0",
      notes: "",
      pub_date: "2026-09-15T19:52:43.278Z",
      platforms: {
        "darwin-x86_64": MAC,
        "darwin-x86_64-app": MAC,
        "darwin-aarch64": MAC,
        "darwin-aarch64-app": MAC,
        "linux-x86_64": LINUX,
        "linux-x86_64-appimage": LINUX,
        "linux-x86_64-deb": LINUX,
        "linux-x86_64-rpm": LINUX,
      },
    });
    expect(Object.keys(parsed?.platforms ?? {})).toHaveLength(8);
  });

  it("drops fields it does not know", () => {
    const parsed = parseUpdate({
      version: "0.2.0",
      platforms: { "linux-x86_64": { ...LINUX, extra: "ignored" } },
    });
    expect(parsed?.platforms["linux-x86_64"]).toEqual(LINUX);
  });
});

describe("mergeManifest", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  it("builds a fresh manifest when nothing is stored", () => {
    const merged = mergeManifest(null, update(), now);
    expect(merged).toEqual({
      version: "0.2.0",
      pub_date: "2026-02-01T00:00:00.000Z",
      notes: "",
      platforms: { "windows-x86_64": WINDOWS },
    });
  });

  it("adds a platform to the same version without disturbing the others", () => {
    const current: ReleaseManifest = {
      version: "0.2.0",
      pub_date: "2026-01-01T00:00:00Z",
      notes: "fixes",
      platforms: { "windows-x86_64": WINDOWS, "darwin-aarch64": MAC },
    };

    const merged = mergeManifest(current, update({ platforms: { "linux-x86_64": LINUX } }), now);

    expect(Object.keys(merged.platforms).sort()).toEqual([
      "darwin-aarch64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(merged.notes).toBe("fixes");
  });

  // The point of the whole design: one platform can be rebuilt on its own.
  it("replaces only the platform that was re-posted", () => {
    const current: ReleaseManifest = {
      version: "0.2.0",
      pub_date: "2026-01-01T00:00:00Z",
      notes: "",
      platforms: { "windows-x86_64": WINDOWS, "darwin-aarch64": MAC },
    };
    const rebuilt = { url: "https://example.test/rebuilt.msi.zip", signature: "sig-win-2" };

    const merged = mergeManifest(current, update({ platforms: { "windows-x86_64": rebuilt } }), now);

    expect(merged.platforms["windows-x86_64"]).toEqual(rebuilt);
    expect(merged.platforms["darwin-aarch64"]).toEqual(MAC);
  });

  // Old platform entries point at the old release's assets, so they must go.
  it("starts over when the version changes", () => {
    const current: ReleaseManifest = {
      version: "0.1.0",
      pub_date: "2026-01-01T00:00:00Z",
      notes: "old",
      platforms: { "darwin-aarch64": MAC, "linux-x86_64": LINUX },
    };

    const merged = mergeManifest(current, update({ version: "0.2.0" }), now);

    expect(merged.version).toBe("0.2.0");
    expect(merged.platforms).toEqual({ "windows-x86_64": WINDOWS });
    expect(merged.notes).toBe("");
  });

  it("takes the posted pub_date over the clock", () => {
    const merged = mergeManifest(null, update({ pub_date: "2026-03-03T03:03:03Z" }), now);
    expect(merged.pub_date).toBe("2026-03-03T03:03:03Z");
  });
});
