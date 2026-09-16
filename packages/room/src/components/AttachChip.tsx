import { useEffect, useState } from "react";
import { Pill, StatusDot } from "@spotjam/ui";
import { useRoomServices, type PlayerControl, type PlayerControlState } from "../services";

/**
 * Whether spotjam drives the local player, and the way back when it does not.
 *
 * Only a shell with a local player has an answer, so a shell that passes no
 * `playerControl` — the web one — gets no chip at all.
 *
 * Detached is the one state the user can act on: spotjam left the player alone
 * because the user took it, and a click hands it back. The other two states are
 * a label, not a control, so they render as a span.
 */
export function AttachChip() {
  const { playerControl } = useRoomServices();
  if (!playerControl) return null;
  return <Chip control={playerControl} />;
}

function Chip({ control }: { control: PlayerControl }) {
  const state = useControlState(control.subscribe);

  if (state === "detached") {
    return (
      <Pill as="button" onClick={control.attach} title="Let spotjam control Spotify again">
        <StatusDot tone="muted" />
        Detached
      </Pill>
    );
  }

  return (
    <Pill as="span">
      <StatusDot tone={state === "following" ? "accent" : "muted"} />
      Attached
    </Pill>
  );
}

/** The driver calls back with the current state on subscribe, so there is no gap to cover. */
function useControlState(
  subscribe: (listener: (control: PlayerControlState) => void) => () => void,
): PlayerControlState {
  const [state, setState] = useState<PlayerControlState>("idle");
  useEffect(() => subscribe(setState), [subscribe]);
  return state;
}
