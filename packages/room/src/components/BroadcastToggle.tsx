import { Pill, StatusDot } from "@spotjam/ui";

export function BroadcastToggle({
  broadcasting,
  onToggle,
}: {
  broadcasting: boolean;
  onToggle: () => void;
}) {
  return (
    <Pill
      active={broadcasting}
      tone="accent"
      onClick={onToggle}
      title={
        broadcasting
          ? "You are broadcasting. Your queue feeds the session."
          : "Start broadcasting to feed your queue into the session."
      }
    >
      <StatusDot tone="current" pulse={broadcasting} glow={broadcasting} />
      {broadcasting ? "Broadcasting" : "Broadcast"}
    </Pill>
  );
}
