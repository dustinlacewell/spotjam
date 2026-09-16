// mode — are we driving the local player, or has the user taken it?
//
// Two states and three events. The user's own choice attaches; their hands on
// Spotify, or their own choice again, detaches. Nothing else moves it.

export type Mode = "attached" | "detached";

export type ModeEvent = "attach" | "detach" | "user-took-player";

export function nextMode(_mode: Mode, event: ModeEvent): Mode {
  switch (event) {
    case "attach":
      return "attached";
    case "detach":
    case "user-took-player":
      return "detached";
  }
}
