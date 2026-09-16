import { describe, expect, it } from "vitest";
import { gatePresentation, NEVER_SELF_RESOLVES, type GatePhase } from "./gate-presentation";
import type { BridgeState } from "../lib/bridge-state";

const ALL: BridgeState[] = ["no-spotify", "no-debug-port", "booting", "ready", "lost"];

describe("gatePresentation", () => {
  /**
   * The whole point of the gate. A spinner with no button is a dead end unless
   * something other than the user will move the state on, so every state that
   * shows one has to be a state Rust genuinely works its way out of.
   */
  it("never leaves the user with a spinner and no way to act", () => {
    for (const state of ALL) {
      if (state === "ready") continue;
      for (const phase of ["fresh", "waited"] as GatePhase[]) {
        const view = gatePresentation(state, phase);
        expect(
          view.canSync || view.spinner,
          `${state}/${phase} shows neither a spinner nor a button`,
        ).toBe(true);
      }
    }
  });

  /**
   * `booting` is where a Spotify parked on its login screen sits forever: the
   * port answers, no xpui page ever appears, and Rust re-probes without ever
   * reaching a different state. A spinner alone there is the forever-spinner.
   */
  it("offers a way out of booting once the wait has gone on too long", () => {
    expect(gatePresentation("booting", "fresh").spinner).toBe(true);
    expect(gatePresentation("booting", "fresh").canSync).toBe(false);

    const waited = gatePresentation("booting", "waited");
    expect(waited.canSync, "a long booting must become actionable").toBe(true);
    expect(waited.reason).toMatch(/sign|log/i);
  });

  /**
   * `no-spotify` self-resolves only because Rust keeps the spawn path open —
   * including on a host where the process lookup failed. It still has to stop
   * spinning if the spawn plainly never worked.
   */
  it("offers a way out of no-spotify once the wait has gone on too long", () => {
    expect(gatePresentation("no-spotify", "fresh").spinner).toBe(true);
    expect(gatePresentation("no-spotify", "waited").canSync).toBe(true);
  });

  /** The two states only the user can fix are actionable from the first render. */
  it("asks the user to act at once on a state that cannot self-resolve", () => {
    for (const state of NEVER_SELF_RESOLVES) {
      const view = gatePresentation(state, "fresh");
      expect(view.canSync, `${state} needs the user immediately`).toBe(true);
      expect(view.spinner).toBe(false);
    }
  });

  /** The debug-port hint belongs to the one state it actually fixes. */
  it("shows the debug-port hint only for no-debug-port", () => {
    for (const state of ALL) {
      if (state === "ready") continue;
      for (const phase of ["fresh", "waited"] as GatePhase[]) {
        const view = gatePresentation(state, phase);
        expect(view.hint !== null, `${state}/${phase}`).toBe(state === "no-debug-port");
      }
    }
  });

  /** Every non-ready state says something; none of them says the same thing twice. */
  it("gives every state its own reason", () => {
    const reasons = ALL.filter((s) => s !== "ready").map((s) => gatePresentation(s, "fresh").reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
  });

  /**
   * A press that answers `booting` has not connected. Saying nothing would read
   * as success, which is the button lying about having tried.
   */
  it("tells the user the attempt did not land when the answer is still booting", () => {
    expect(gatePresentation("booting", "waited").afterAttempt).toMatch(/still/i);
    expect(gatePresentation("no-debug-port", "waited").afterAttempt).not.toBeNull();
  });
});
