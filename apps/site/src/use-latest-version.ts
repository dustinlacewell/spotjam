// The latest released version, as the update server reports it.
//
// The site is static, so it has no version of its own worth showing. What
// matters to a visitor is what they would download, which is exactly the
// document the desktop updater reads.

import { useEffect, useState } from "react";

import { MANIFEST_URL } from "./links";

/** Absent until the fetch answers; null when there is no release yet. */
export type LatestVersion = { state: "loading" } | { state: "known"; version: string | null };

function versionOf(document: unknown): string | null {
  if (typeof document !== "object" || document === null) return null;
  const { version } = document as Record<string, unknown>;
  return typeof version === "string" && version !== "" ? version : null;
}

export function useLatestVersion(url: string = MANIFEST_URL): LatestVersion {
  const [latest, setLatest] = useState<LatestVersion>({ state: "loading" });

  useEffect(() => {
    const aborter = new AbortController();

    void (async () => {
      try {
        const response = await fetch(url, { signal: aborter.signal });
        // 204 is the server saying nothing has been released yet.
        if (response.status === 204) {
          setLatest({ state: "known", version: null });
          return;
        }
        if (!response.ok) {
          setLatest({ state: "known", version: null });
          return;
        }
        setLatest({ state: "known", version: versionOf(await response.json()) });
      } catch {
        // An unreachable server is not worth a message on a landing page; the
        // download link works regardless.
        if (!aborter.signal.aborted) setLatest({ state: "known", version: null });
      }
    })();

    return () => aborter.abort();
  }, [url]);

  return latest;
}
