// Turning a release's files into something a person can choose from.
//
// The manifest carries bare filenames. Which one someone wants depends on
// their OS and, on a Mac, their chip — so each file earns a label and a group.
// Pure: the naming rules are testable without a page.

/** One file on the release, as the manifest reports it. */
export interface Download {
  name: string;
  url: string;
  size: number;
}

/** A download, once we know what it is. */
export interface LabelledDownload extends Download {
  os: "windows" | "macos" | "linux";
  label: string;
}

/** Downloads for one operating system, in the order they should be offered. */
export interface DownloadGroup {
  os: "windows" | "macos" | "linux";
  title: string;
  items: LabelledDownload[];
}

const GROUP_TITLES: Record<LabelledDownload["os"], string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/** Offered in this order: the installer most people want comes first. */
const GROUP_ORDER: LabelledDownload["os"][] = ["windows", "macos", "linux"];

/**
 * What a file is, by its name.
 *
 * Tauri's bundle names carry the arch, so an Apple Silicon Mac and an Intel
 * one are told apart here rather than guessed from the browser.
 */
function describe(name: string): { os: LabelledDownload["os"]; label: string } | null {
  const lower = name.toLowerCase();

  if (lower.endsWith("-setup.exe")) return { os: "windows", label: "Installer (.exe)" };
  if (lower.endsWith(".msi")) return { os: "windows", label: "Installer (.msi)" };

  if (lower.endsWith(".dmg")) {
    const apple = lower.includes("aarch64") || lower.includes("arm64");
    return { os: "macos", label: apple ? "Apple Silicon (.dmg)" : "Intel (.dmg)" };
  }

  if (lower.endsWith(".appimage")) return { os: "linux", label: "AppImage" };
  if (lower.endsWith(".deb")) return { os: "linux", label: "Debian / Ubuntu (.deb)" };
  if (lower.endsWith(".rpm")) return { os: "linux", label: "Fedora / RHEL (.rpm)" };

  // Signatures, the manifest itself, anything unrecognised: not for people.
  return null;
}

/** Bytes as a short human string. Sizes here are megabytes, so one decimal. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Group a release's files by operating system.
 *
 * Unrecognised files are dropped rather than shown unlabelled, and an OS with
 * nothing to offer does not appear at all.
 */
export function groupDownloads(downloads: readonly Download[]): DownloadGroup[] {
  const labelled: LabelledDownload[] = [];

  for (const download of downloads) {
    const described = describe(download.name);
    if (described === null) continue;
    labelled.push({ ...download, ...described });
  }

  return GROUP_ORDER.map((os) => ({
    os,
    title: GROUP_TITLES[os],
    items: labelled.filter((item) => item.os === os),
  })).filter((group) => group.items.length > 0);
}
