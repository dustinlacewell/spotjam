// bridge-state — what the Rust side says about its line to the Spotify client.
//
// The bridge can be down for reasons the user can act on (Spotify is not
// running, or it is running without the debugging flag) and for reasons that
// pass on their own (it is booting, the connection dropped). Rust emits every
// change on one event; this module turns that into a subscription the UI and
// the sync driver can read.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export type BridgeState = "no-spotify" | "no-debug-port" | "booting" | "ready" | "lost";

/** The Tauri event Rust emits on every bridge state change, and once at startup. */
const BRIDGE_EVENT = "spotify-bridge";

export interface BridgeStateSource {
  /** Calls back with the current state immediately, then on every change. */
  subscribe(listener: (state: BridgeState) => void): () => void;
  /** Forces a connect attempt and answers with the state it produced. */
  connect(): Promise<BridgeState>;
}

/**
 * True when the bridge has just come back from being down.
 *
 * Pure so the driver's "re-apply the room pointer" rule is testable without a
 * bridge: the first state we ever see is not a recovery, however good it is.
 */
export function cameBack(prev: BridgeState | null, next: BridgeState): boolean {
  return next === "ready" && prev !== null && prev !== "ready";
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (
  event: string,
  handler: (event: { payload: { state: BridgeState } }) => void,
) => Promise<() => void>;

export interface BridgeStateDeps {
  listen: Listen;
  invoke: Invoke;
}

/**
 * The source over an injected Tauri pair, so tests need no runtime.
 *
 * Both halves of `subscribe` are async and neither is awaited by the caller, so
 * unsubscribing has to survive arriving first: the flag is what actually stops
 * a late listener, and the unlisten handle is released whenever it lands.
 */
export function makeBridgeStateSource({ listen, invoke }: BridgeStateDeps): BridgeStateSource {
  return {
    subscribe(listener) {
      let live = true;
      let unlisten: (() => void) | null = null;

      // The initial read waits for the listener to be registered. Asking first
      // would leave a window where a change is neither in the answer we already
      // hold nor in an event we are not yet listening for, and nothing re-polls:
      // the UI would sit on a stale state for as long as the bridge stayed put.
      void listen(BRIDGE_EVENT, (event) => {
        if (live) listener(event.payload.state);
      })
        .then((off) => {
          if (live) unlisten = off;
          else off();
        })
        .then(() => invoke<BridgeState>("spotify_bridge_state"))
        .then(
          (state) => {
            if (live) listener(state);
          },
          (error) => {
            console.warn("spotjam: could not read the bridge state", error);
          },
        );

      return () => {
        live = false;
        unlisten?.();
        unlisten = null;
      };
    },

    connect() {
      return invoke<BridgeState>("spotify_connect");
    },
  };
}

export const tauriBridgeState: BridgeStateSource = makeBridgeStateSource({
  listen: tauriListen as unknown as Listen,
  invoke: tauriInvoke as Invoke,
});
