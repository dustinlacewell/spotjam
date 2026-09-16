import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, HintLine } from "@spotjam/ui";
import type { BridgeState, BridgeStateSource } from "../lib/bridge-state";
import type { PlaybackDriver } from "../lib/playback/driver";
import { gatePresentation, PATIENCE_MS, type GatePhase } from "./gate-presentation";
import styles from "./SpotifyGate.module.css";

/**
 * Null until the bridge answers; the overlay waits rather than guessing.
 *
 * `apply` exists for the Sync button: `spotify_connect` answers with the state
 * it produced, and that answer is only echoed as an event when the state
 * actually moved. Connecting a bridge that Rust already considers ready emits
 * nothing, so without applying the answer the overlay could never clear.
 */
export function useBridgeState(source: BridgeStateSource): {
  state: BridgeState | null;
  apply: (state: BridgeState) => void;
} {
  const [state, setState] = useState<BridgeState | null>(null);
  useEffect(() => source.subscribe(setState), [source]);
  return { state, apply: setState };
}

/**
 * How long this state has been the state.
 *
 * A self-resolving state is only self-resolving in the ordinary case; a Spotify
 * on its login screen sits at `booting` forever. The gate therefore stops
 * spinning after `PATIENCE_MS` and offers the user something to do. The timer
 * restarts whenever the state changes, so progress through several states never
 * accumulates into a false "we have waited long enough".
 */
function useGatePhase(state: BridgeState | null): GatePhase {
  const [phase, setPhase] = useState<GatePhase>("fresh");

  useEffect(() => {
    setPhase("fresh");
    if (state === null || state === "ready") return;
    const id = setTimeout(() => setPhase("waited"), PATIENCE_MS);
    return () => clearTimeout(id);
  }, [state]);

  return phase;
}

interface SpotifyGateProps {
  source: BridgeStateSource;
  driver: PlaybackDriver;
  children: ReactNode;
}

/**
 * The room over a dim layer whenever the bridge to Spotify is down.
 *
 * The room stays mounted and rendered underneath: queueing and voting are the
 * server's business and work without a local player. Only the part that needs
 * Spotify is blocked, and it unblocks itself the moment the bridge reports
 * ready.
 */
export function SpotifyGate({ source, driver, children }: SpotifyGateProps) {
  const { state, apply } = useBridgeState(source);
  const phase = useGatePhase(state);

  return (
    <>
      {children}
      {state !== null && state !== "ready" && (
        <Blocker
          view={gatePresentation(state, phase)}
          onSync={async () => {
            const answer = await source.connect();
            apply(answer);
            driver.attach();
            return answer;
          }}
        />
      )}
    </>
  );
}

/**
 * The panel itself.
 *
 * A press that answered with a state other than `ready` has not connected, and
 * the overlay it is sitting on does not say so on its own — the panel looks
 * identical before and after. `spotify_connect` waits only three seconds on an
 * attempt already in flight, so a press landing mid-poll answers `booting` as a
 * matter of course. Reporting that in a line under the button is what keeps the
 * button from reading as a no-op the user should press harder.
 */
function Blocker({
  view,
  onSync,
}: {
  view: ReturnType<typeof gatePresentation>;
  onSync: () => Promise<BridgeState>;
}) {
  const [busy, setBusy] = useState(false);
  const [attemptResult, setAttemptResult] = useState<string | null>(null);
  // A press whose answer lands after the gate closes must not set state on a
  // panel that is gone.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A state change is news that supersedes the last press's verdict.
  useEffect(() => setAttemptResult(null), [view.reason]);

  async function sync() {
    setBusy(true);
    setAttemptResult(null);
    try {
      const answer = await onSync();
      if (!live.current) return;
      // `ready` closes the gate on its own; anything else owes the user a word.
      setAttemptResult(answer === "ready" ? null : gatePresentation(answer, "waited").afterAttempt);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Spotify is not connected"
    >
      <div className={styles.panel}>
        <h2 className={styles.title}>Spotify is not connected</h2>
        <p className={styles.reason}>{view.reason}</p>
        {view.spinner || busy ? (
          <div className={styles.spinner} role="status" aria-label="Waiting for Spotify" />
        ) : (
          <>
            {view.hint && <HintLine reserveSpace={false}>{view.hint}</HintLine>}
            {attemptResult && (
              <p className={styles.reason} role="status">
                {attemptResult}
              </p>
            )}
            {view.canSync && (
              <Button type="button" onClick={() => void sync()}>
                Sync
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
