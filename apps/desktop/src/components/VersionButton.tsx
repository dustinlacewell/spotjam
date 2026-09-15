// The version, and the update it offers.
//
// One control: it reads as a quiet version label until an update exists, then
// becomes the button that installs it. What each state says and whether it can
// be pressed comes from lib/update-status.ts.

import { isActionable, updateLabel, updateTone, type UpdateStatus } from "../lib/update-status";
import { useUpdate } from "./use-update";
import styles from "./VersionButton.module.css";

const toneClass: Record<ReturnType<typeof updateTone>, string> = {
  muted: styles.muted,
  accent: styles.accent,
  error: styles.error,
};

export function VersionButton() {
  const { status, install } = useUpdate();
  return <VersionButtonView status={status} onInstall={() => void install()} />;
}

/** The view, given its state: no I/O, so a story or test can render any state. */
export function VersionButtonView({
  status,
  onInstall,
}: {
  status: UpdateStatus;
  onInstall: () => void;
}) {
  const label = updateLabel(status);
  const actionable = isActionable(status);
  const className = [styles.base, toneClass[updateTone(status)]].join(" ");

  // Nothing to press is not a disabled button; it is a label. A disabled
  // control invites a click that will never work.
  if (!actionable) {
    return (
      <p className={className} aria-live="polite">
        {label}
      </p>
    );
  }

  return (
    <button type="button" className={className} onClick={onInstall} aria-live="polite">
      {label}
    </button>
  );
}
