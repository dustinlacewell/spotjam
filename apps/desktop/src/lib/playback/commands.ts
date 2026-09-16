// commands — the six things we can tell Spotify to do.
//
// One flat union, so a command can be compared, queued, and matched against an
// observation without anyone reaching into the bridge. `targetOf` names what a
// command is aimed at, which is how repeated failures are counted.

export type Command =
  | { kind: "play"; uri: string }
  | { kind: "seek"; positionMs: number }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "set-next"; uri: string }
  | { kind: "clear-queue" };

export type CommandKind = Command["kind"];

/**
 * What a command aims at, as one string.
 *
 * Two plays of the same track are the same target; two plays of different
 * tracks are not. A track that will not play must stop being re-issued, and a
 * different track must not inherit that verdict.
 */
export function targetOf(command: Command): string {
  switch (command.kind) {
    case "play":
      return `play:${command.uri}`;
    case "seek":
      return `seek:${command.positionMs}`;
    case "set-next":
      return `set-next:${command.uri}`;
    default:
      return command.kind;
  }
}
