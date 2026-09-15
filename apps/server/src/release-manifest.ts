// The updater manifest — what the desktop client asks for when it checks for
// an update.
//
// Tauri's updater fetches one JSON document describing the newest version and,
// per platform, where to download it and the signature to verify it with. CI
// is the only writer: each platform's release workflow posts the entries it
// just built. Nothing here reaches the network; the decisions are pure so the
// merge rule cannot drift from its test.

/** One platform's download, as Tauri's updater expects it. */
export interface ManifestPlatform {
  url: string;
  signature: string;
}

/**
 * One installer a person can download.
 *
 * The updater's platform URLs are asset-id endpoints that only resolve with an
 * octet-stream Accept header, so they are useless as links on a page. These
 * are the browser URLs for the same release.
 */
export interface Download {
  name: string;
  url: string;
  size: number;
}

/** The document served at /latest.json. */
export interface ReleaseManifest {
  version: string;
  pub_date: string;
  notes: string;
  platforms: Record<string, ManifestPlatform>;
  downloads: Download[];
}

/** What one workflow posts: its own platforms, for one version. */
export interface ManifestUpdate {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, ManifestPlatform>;
  downloads?: Download[];
}

/**
 * Tauri's platform keys, e.g. `windows-x86_64`.
 *
 * A key may carry a bundle suffix — `linux-x86_64-appimage`, `darwin-x86_64-app`
 * — which lets a client ask for one installer type. Both forms are stored, so
 * what the server serves matches what the release actually holds.
 */
const PLATFORM_KEY = /^(darwin|linux|windows)-(x86_64|aarch64|i686|armv7)(-[a-z0-9]+)?$/;

function isPlatform(value: unknown): value is ManifestPlatform {
  if (typeof value !== "object" || value === null) return false;
  const { url, signature } = value as Record<string, unknown>;
  return typeof url === "string" && url !== "" && typeof signature === "string" && signature !== "";
}

/** Where a download may point. The site turns these into links people click. */
const DOWNLOAD_ORIGIN = "https://github.com/";

function isDownload(value: unknown): value is Download {
  if (typeof value !== "object" || value === null) return false;
  const { name, url, size } = value as Record<string, unknown>;

  if (typeof name !== "string" || name === "") return false;
  if (typeof url !== "string" || !url.startsWith(DOWNLOAD_ORIGIN)) return false;
  return typeof size === "number" && Number.isInteger(size) && size > 0;
}

/**
 * Validate the download list.
 *
 * Absent means "this post has nothing to say about downloads"; present but
 * malformed is refused, so a bad entry cannot become a link on the page.
 */
function parseDownloads(value: unknown): Download[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;

  const validated: Download[] = [];
  for (const entry of value) {
    if (!isDownload(entry)) return null;
    validated.push({ name: entry.name, url: entry.url, size: entry.size });
  }
  return validated;
}

/**
 * Validate a posted update.
 *
 * CI is trusted with the token, not with the shape: a malformed post must be
 * refused rather than served to every client as an unparseable manifest.
 */
export function parseUpdate(body: unknown): ManifestUpdate | null {
  if (typeof body !== "object" || body === null) return null;
  const { version, pub_date, notes, platforms } = body as Record<string, unknown>;

  if (typeof version !== "string" || version === "") return null;
  if (pub_date !== undefined && typeof pub_date !== "string") return null;
  if (notes !== undefined && typeof notes !== "string") return null;
  if (typeof platforms !== "object" || platforms === null) return null;

  const downloads = parseDownloads((body as Record<string, unknown>).downloads);
  if (downloads === null) return null;

  const entries = Object.entries(platforms as Record<string, unknown>);
  if (entries.length === 0) return null;

  const validated: Record<string, ManifestPlatform> = {};
  for (const [key, value] of entries) {
    if (!PLATFORM_KEY.test(key)) return null;
    if (!isPlatform(value)) return null;
    validated[key] = { url: value.url, signature: value.signature };
  }

  return {
    version,
    ...(pub_date === undefined ? {} : { pub_date }),
    ...(notes === undefined ? {} : { notes }),
    ...(downloads === undefined ? {} : { downloads }),
    platforms: validated,
  };
}

/**
 * Fold one workflow's post into what is already stored.
 *
 * Per-platform merge is what keeps the release workflows independent: a
 * Windows-only re-run replaces the Windows entry and leaves macOS and Linux
 * standing. Replace-semantics would mean whichever job finished last was the
 * only platform anyone could update to.
 *
 * A post for a newer version starts a fresh document — the old version's
 * platforms are not carried forward, because they point at the old release.
 */
export function mergeManifest(
  current: ReleaseManifest | null,
  update: ManifestUpdate,
  now: number,
): ReleaseManifest {
  const pubDate = update.pub_date ?? new Date(now).toISOString();
  const sameVersion = current !== null && current.version === update.version;

  // Every workflow sees the whole release, so a posted list is already
  // complete — it replaces rather than merges. Platforms are the opposite:
  // each job knows only what it built.
  const downloads =
    update.downloads !== undefined && update.downloads.length > 0
      ? update.downloads
      : sameVersion
        ? current.downloads
        : [];

  return {
    version: update.version,
    pub_date: pubDate,
    notes: update.notes ?? (sameVersion ? current.notes : ""),
    platforms: sameVersion
      ? { ...current.platforms, ...update.platforms }
      : { ...update.platforms },
    downloads,
  };
}
