// The latest release, as the update server reports it.
//
// The site is static, so it has no version of its own worth showing. What
// matters to a visitor is what they would download, which is exactly the
// document the desktop updater reads.

import { useEffect, useState } from "react";

import type { Download } from "./lib/downloads";
import { MANIFEST_URL } from "./links";

/** Absent until the fetch answers; a null version means no release yet. */
export type LatestRelease =
  | { state: "loading" }
  | { state: "known"; version: string | null; downloads: Download[] };

const NOTHING: LatestRelease = { state: "known", version: null, downloads: [] };

function versionOf(document: Record<string, unknown>): string | null {
  const { version } = document;
  return typeof version === "string" && version !== "" ? version : null;
}

/** Trust the shape no further than it has been checked. */
function downloadsOf(document: Record<string, unknown>): Download[] {
  const { downloads } = document;
  if (!Array.isArray(downloads)) return [];

  return downloads.filter((entry): entry is Download => {
    if (typeof entry !== "object" || entry === null) return false;
    const { name, url, size } = entry as Record<string, unknown>;
    return typeof name === "string" && typeof url === "string" && typeof size === "number";
  });
}

export function useLatestRelease(url: string = MANIFEST_URL): LatestRelease {
  const [latest, setLatest] = useState<LatestRelease>({ state: "loading" });

  useEffect(() => {
    const aborter = new AbortController();

    void (async () => {
      try {
        const response = await fetch(url, { signal: aborter.signal });
        // 204 is the server saying nothing has been released yet.
        if (response.status === 204 || !response.ok) {
          setLatest(NOTHING);
          return;
        }

        const document = (await response.json()) as Record<string, unknown>;
        setLatest({
          state: "known",
          version: versionOf(document),
          downloads: downloadsOf(document),
        });
      } catch {
        // An unreachable server is not worth a message on a landing page; the
        // releases link still works.
        if (!aborter.signal.aborted) setLatest(NOTHING);
      }
    })();

    return () => aborter.abort();
  }, [url]);

  return latest;
}
