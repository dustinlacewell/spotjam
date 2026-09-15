import { describe, expect, it } from "vitest";

import { formatSize, groupDownloads, type Download } from "./downloads.ts";

function file(name: string, size = 3_000_000): Download {
  return { name, url: `https://github.com/dustinlacewell/spotjam/releases/download/v0.1.0/${name}`, size };
}

/** The seven installers a real 0.1.0 release carries. */
const RELEASE: Download[] = [
  file("spotjam-0.1.0-1.x86_64.rpm"),
  file("spotjam_0.1.0_aarch64.dmg"),
  file("spotjam_0.1.0_amd64.AppImage"),
  file("spotjam_0.1.0_amd64.deb"),
  file("spotjam_0.1.0_x64-setup.exe"),
  file("spotjam_0.1.0_x64.dmg"),
  file("spotjam_0.1.0_x64_en-US.msi"),
];

describe("groupDownloads", () => {
  it("offers Windows, macOS and Linux in that order", () => {
    expect(groupDownloads(RELEASE).map((group) => group.os)).toEqual([
      "windows",
      "macos",
      "linux",
    ]);
  });

  // The arch is in the filename, so the two Macs are told apart rather than
  // guessed from the browser.
  it("separates Apple Silicon from Intel", () => {
    const macos = groupDownloads(RELEASE).find((group) => group.os === "macos");
    expect(macos?.items.map((item) => item.label).sort()).toEqual([
      "Apple Silicon (.dmg)",
      "Intel (.dmg)",
    ]);
  });

  it("labels both Windows installers", () => {
    const windows = groupDownloads(RELEASE).find((group) => group.os === "windows");
    expect(windows?.items.map((item) => item.label).sort()).toEqual([
      "Installer (.exe)",
      "Installer (.msi)",
    ]);
  });

  it("labels each Linux package by the distro that wants it", () => {
    const linux = groupDownloads(RELEASE).find((group) => group.os === "linux");
    expect(linux?.items.map((item) => item.label).sort()).toEqual([
      "AppImage",
      "Debian / Ubuntu (.deb)",
      "Fedora / RHEL (.rpm)",
    ]);
  });

  // Signatures and the manifest are updater plumbing, not downloads.
  it("drops files that are not for people", () => {
    const grouped = groupDownloads([
      ...RELEASE,
      file("latest.json"),
      file("spotjam_0.1.0_x64_en-US.msi.sig"),
      file("spotjam_0.1.0_amd64.AppImage.sig"),
    ]);
    const names = grouped.flatMap((group) => group.items.map((item) => item.name));
    expect(names).toHaveLength(7);
    expect(names.some((name) => name.endsWith(".sig"))).toBe(false);
  });

  it("omits an operating system with nothing to offer", () => {
    const grouped = groupDownloads([file("spotjam_0.1.0_x64_en-US.msi")]);
    expect(grouped.map((group) => group.os)).toEqual(["windows"]);
  });

  it("returns nothing for an empty release", () => {
    expect(groupDownloads([])).toEqual([]);
  });

  it("carries the url and size through", () => {
    const [windows] = groupDownloads([file("spotjam_0.1.0_x64_en-US.msi", 3_653_632)]);
    expect(windows?.items[0]).toMatchObject({
      size: 3_653_632,
      url: expect.stringContaining("releases/download/v0.1.0/"),
    });
  });
});

describe("formatSize", () => {
  it.each([
    [3_653_632, "3.5 MB"],
    [83_638_776, "80 MB"],
    [512_000, "0.5 MB"],
    [2_147_483_648, "2.0 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });
});
