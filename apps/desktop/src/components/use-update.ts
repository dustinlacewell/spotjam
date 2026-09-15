// The updater, at the edge.
//
// Every decision about what to show lives in lib/update-status.ts. This hook
// only moves bytes: it asks the plugin what exists, drives a download, and
// reports each step back as one of that module's states.

import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import {
  DownloadProgress,
  type ProgressEvent,
  type UpdateStatus,
} from "../lib/update-status";

/** What an update looks like to this hook, so a test can stand one in. */
interface PendingUpdate {
  version: string;
  downloadAndInstall(onEvent: (event: ProgressEvent) => void): Promise<void>;
}

/** The I/O this hook performs, injected so it can be faked. */
export interface UpdaterPort {
  currentVersion(): Promise<string>;
  findUpdate(): Promise<PendingUpdate | null>;
  restart(): Promise<void>;
}

/** The real one, talking to the Tauri plugins. */
export const tauriUpdater: UpdaterPort = {
  currentVersion: () => getVersion(),
  findUpdate: async () => {
    const update = await check();
    if (update === null) return null;
    return {
      version: update.version,
      downloadAndInstall: (onEvent) =>
        update.downloadAndInstall((event) => onEvent(event as ProgressEvent)),
    };
  },
  restart: () => relaunch(),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The version button's state, and the action it fires.
 *
 * The check runs once on mount. A failure to reach the server is not an error
 * worth showing — the app simply reports the version it is, since an unknown
 * update is indistinguishable from none.
 */
export function useUpdate(port: UpdaterPort = tauriUpdater) {
  const [status, setStatus] = useState<UpdateStatus>({ state: "checking" });
  const pending = useRef<PendingUpdate | null>(null);
  const version = useRef<string>("");

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const current = await port.currentVersion();
        if (cancelled) return;
        version.current = current;

        const update = await port.findUpdate();
        if (cancelled) return;

        if (update === null) {
          setStatus({ state: "current", version: current });
          return;
        }
        pending.current = update;
        setStatus({ state: "available", version: current, latest: update.version });
      } catch {
        // An unreachable update server tells us nothing about the app itself.
        if (cancelled) return;
        setStatus(
          version.current === ""
            ? { state: "checking" }
            : { state: "current", version: version.current },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [port]);

  const install = useCallback(async () => {
    const update = pending.current;
    if (update === null) return;

    const current = version.current;
    const progress = new DownloadProgress();
    setStatus({ state: "downloading", version: current, latest: update.version, percent: null });

    try {
      await update.downloadAndInstall((event) => {
        const percent = progress.apply(event);
        setStatus(
          event.event === "Finished"
            ? { state: "installing", version: current, latest: update.version }
            : { state: "downloading", version: current, latest: update.version, percent },
        );
      });
      setStatus({ state: "restart", version: current, latest: update.version });
      await port.restart();
    } catch (error) {
      setStatus({ state: "failed", version: current, message: messageOf(error) });
    }
  }, [port]);

  return { status, install } as const;
}
