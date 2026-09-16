import { useEffect, useState } from "react";
import { Pill, StatusDot } from "@spotjam/ui";
import { useRoomServices, type PlayerControl, type PlayerControlState } from "../services";

/**
 * Whether spotjam drives the local player, and the way in or out.
 *
 * Only a shell with a local player has an answer, so a shell that passes no
 * `playerControl` — the web one — gets no chip at all.
 *
 * Attached and detached are both the user's to change, so both are buttons: one
 * hands the player back to them, the other takes it again. With no Spotify
 * there is nothing to hand either way, so that state is a label.
 */
export function AttachChip() {
  const { playerControl } = useRoomServices();
  if (!playerControl) return null;
  return <Chip control={playerControl} />;
}

function Chip({ control }: { control: PlayerControl }) {
  const state = useControlState(control.subscribe);

  if (state === "no-spotify") {
    return (
      <Pill as="span">
        <StatusDot tone="muted" />
        No Spotify
      </Pill>
    );
  }

  if (state === "detached") {
    return (
      <Pill as="button" onClick={control.attach} title="Let spotjam control Spotify again">
        <StatusDot tone="muted" />
        Detached
      </Pill>
    );
  }

  return (
    <Pill as="button" onClick={control.detach} title="Stop controlling Spotify">
      <StatusDot tone="accent" />
      Attached
    </Pill>
  );
}

/** The driver calls back with the current state on subscribe, so there is no gap to cover. */
function useControlState(
  subscribe: (listener: (state: PlayerControlState) => void) => () => void,
): PlayerControlState {
  const [state, setState] = useState<PlayerControlState>("no-spotify");
  useEffect(() => subscribe(setState), [subscribe]);
  return state;
}
