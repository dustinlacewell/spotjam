import { describe, expect, it, vi } from "vitest";
import { cameBack, makeBridgeStateSource, type BridgeState } from "./bridge-state";

describe("cameBack", () => {
  it("is false for the first state we ever see, even a good one", () => {
    expect(cameBack(null, "ready")).toBe(false);
  });

  it("is true when a down bridge turns ready", () => {
    expect(cameBack("lost", "ready")).toBe(true);
    expect(cameBack("no-spotify", "ready")).toBe(true);
    expect(cameBack("booting", "ready")).toBe(true);
  });

  it("is false while the bridge stays ready", () => {
    expect(cameBack("ready", "ready")).toBe(false);
  });

  it("is false for any state that is not ready", () => {
    expect(cameBack("ready", "lost")).toBe(false);
    expect(cameBack(null, "no-spotify")).toBe(false);
  });
});

/** A Tauri pair under test control: the event handler and the command answers. */
function makeTauri(initial: BridgeState = "ready") {
  let handler: ((event: { payload: { state: BridgeState } }) => void) | null = null;
  const unlisten = vi.fn();
  let resolveListen: (() => void) | null = null;

  const listen = (
    _event: string,
    given: (event: { payload: { state: BridgeState } }) => void,
  ): Promise<() => void> => {
    handler = given;
    // Resolution is deferred so a test can unsubscribe before the handle lands.
    return new Promise((resolve) => {
      resolveListen = () => resolve(unlisten);
    });
  };

  const invoke = vi.fn(async <T,>(cmd: string): Promise<T> => {
    if (cmd === "spotify_bridge_state") return initial as T;
    if (cmd === "spotify_connect") return "ready" as T;
    return undefined as T;
  });

  return {
    listen,
    invoke: invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
    unlisten,
    calls: invoke,
    emit(state: BridgeState) {
      handler?.({ payload: { state } });
    },
    /**
     * Lets the pending `listen` promise settle, and the initial state read that
     * is chained behind it. Several ticks because the chain is several links
     * long; the count is slack, not a contract.
     */
    settleListen: async () => {
      resolveListen?.();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
  };
}

describe("makeBridgeStateSource", () => {
  it("hands the listener the current state without waiting for an event", async () => {
    const tauri = makeTauri("no-debug-port");
    const source = makeBridgeStateSource(tauri);
    const seen: BridgeState[] = [];

    source.subscribe((state) => seen.push(state));
    await tauri.settleListen();

    expect(seen).toEqual(["no-debug-port"]);
  });

  it("forwards every emitted change", async () => {
    const tauri = makeTauri("booting");
    const source = makeBridgeStateSource(tauri);
    const seen: BridgeState[] = [];

    source.subscribe((state) => seen.push(state));
    await tauri.settleListen();
    tauri.emit("ready");
    tauri.emit("lost");

    expect(seen).toEqual(["booting", "ready", "lost"]);
  });

  it("stops forwarding after unsubscribe and releases the listener", async () => {
    const tauri = makeTauri("ready");
    const source = makeBridgeStateSource(tauri);
    const seen: BridgeState[] = [];

    const off = source.subscribe((state) => seen.push(state));
    await tauri.settleListen();
    seen.length = 0;
    off();
    tauri.emit("lost");

    expect(seen).toEqual([]);
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases a listen handle that lands after unsubscribe", async () => {
    const tauri = makeTauri("ready");
    const source = makeBridgeStateSource(tauri);

    const off = source.subscribe(() => {});
    off();
    await tauri.settleListen();

    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });

  it("drops the initial read that lands after unsubscribe", async () => {
    const tauri = makeTauri("lost");
    const source = makeBridgeStateSource(tauri);
    const seen: BridgeState[] = [];

    const off = source.subscribe((state) => seen.push(state));
    off();
    await tauri.settleListen();

    expect(seen).toEqual([]);
  });

  it("does not read the state until the listener is registered", async () => {
    const tauri = makeTauri("booting");
    const source = makeBridgeStateSource(tauri);

    source.subscribe(() => {});
    // The listen promise is still pending, so nothing has been asked yet. A read
    // issued here could be overtaken by a change whose event we would miss.
    expect(tauri.calls).not.toHaveBeenCalled();

    await tauri.settleListen();
    expect(tauri.calls).toHaveBeenCalledWith("spotify_bridge_state");
  });

  it("connect asks Rust to attempt a connection and answers with the result", async () => {
    const tauri = makeTauri("no-spotify");
    const source = makeBridgeStateSource(tauri);

    await expect(source.connect()).resolves.toBe("ready");
    expect(tauri.calls).toHaveBeenCalledWith("spotify_connect");
  });
});
