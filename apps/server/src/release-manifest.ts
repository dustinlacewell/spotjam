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

/** The document served at /latest.json. */
export interface ReleaseManifest {
  version: string;
  pub_date: string;
  notes: string;
  platforms: Record<string, ManifestPlatform>;
}

/** What one workflow posts: its own platforms, for one version. */
export interface ManifestUpdate {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, ManifestPlatform>;
}

/** Tauri's platform keys, e.g. `windows-x86_64`. */
const PLATFORM_KEY = /^(darwin|linux|windows)-(x86_64|aarch64|i686|armv7)$/;

function isPlatform(value: unknown): value is ManifestPlatform {
  if (typeof value !== "object" || value === null) return false;
  const { url, signature } = value as Record<string, unknown>;
  return typeof url === "string" && url !== "" && typeof signature === "string" && signature !== "";
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

  return {
    version: update.version,
    pub_date: pubDate,
    notes: update.notes ?? (sameVersion ? current.notes : ""),
    platforms: sameVersion
      ? { ...current.platforms, ...update.platforms }
      : { ...update.platforms },
  };
}
