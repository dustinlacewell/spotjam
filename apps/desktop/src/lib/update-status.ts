// What the version button knows.
//
// The updater's answer is a nullable Update object and a progress stream. The
// button needs one value it can render. This module turns the first into the
// second and does no I/O, so every state the button can reach is reachable in
// a test.

/** Every state the version button can be in. */
export type UpdateStatus =
  | { state: "checking" }
  | { state: "current"; version: string }
  | { state: "available"; version: string; latest: string }
  | { state: "downloading"; version: string; latest: string; percent: number | null }
  | { state: "installing"; version: string; latest: string }
  | { state: "restart"; version: string; latest: string }
  | { state: "failed"; version: string; message: string };

/** What the updater reports back while a download runs. */
export type ProgressEvent =
  | { event: "Started"; data: { contentLength?: number | undefined } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/**
 * Track a download's progress across events.
 *
 * The updater reports chunk sizes, not a running total, and may not know the
 * content length at all — so this accumulates, and yields null rather than a
 * fake percentage when the total is unknown.
 */
export class DownloadProgress {
  #total: number | null = null;
  #received = 0;

  /** Fold one event in; returns the percentage to show, or null if unknown. */
  apply(event: ProgressEvent): number | null {
    if (event.event === "Started") {
      this.#total = event.data.contentLength ?? null;
      this.#received = 0;
      return this.percent;
    }
    if (event.event === "Progress") {
      this.#received += event.data.chunkLength;
      return this.percent;
    }
    this.#received = this.#total ?? this.#received;
    return this.percent;
  }

  get percent(): number | null {
    if (this.#total === null || this.#total <= 0) return null;
    return Math.min(100, Math.round((this.#received / this.#total) * 100));
  }
}

/** The label the button shows for a status. */
export function updateLabel(status: UpdateStatus): string {
  switch (status.state) {
    case "checking":
      return "Checking…";
    case "current":
      return `v${status.version}`;
    case "available":
      return `Update to v${status.latest}`;
    case "downloading":
      return status.percent === null ? "Downloading…" : `Downloading ${status.percent}%`;
    case "installing":
      return "Installing…";
    case "restart":
      return "Restart to finish";
    case "failed":
      return `v${status.version} — update failed`;
  }
}

/** Whether pressing the button does anything in this state. */
export function isActionable(status: UpdateStatus): boolean {
  return status.state === "available" || status.state === "failed";
}

/**
 * The button's tone.
 *
 * An available update is the only state worth drawing attention to; a current
 * version is deliberately quiet, since it is the common case and says nothing
 * the user needs to act on.
 */
export function updateTone(status: UpdateStatus): "muted" | "accent" | "error" {
  if (status.state === "failed") return "error";
  if (status.state === "available" || status.state === "restart") return "accent";
  return "muted";
}
