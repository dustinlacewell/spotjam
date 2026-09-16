# Attached is a mode

Whether spotjam drives the local player is an explicit state, not something
inferred each tick. The old layer worked it out from what Spotify was
playing, which meant an unexpected track had to mean both "the user took the
player" and "our command has not landed yet", and the two could only be
told apart by waiting.

Now it is two states and three events, in `mode.ts`.

```
attach            -> attached
detach            -> detached
user-took-player  -> detached
```

That is the whole machine. `attach` and `detach` are the user pressing the
chip. `user-took-player` is `classify` returning `"user"`. Nothing else
moves it: not a bridge outage, not a failed command, not a stuck track.

## Detaching

When `classify` says `"user"`, the driver clears its outstanding
expectations and
switches to detached before it issues anything. A user who has taken the
player must not receive one more command on the way out.

Detached, the driver still ticks and still observes. It just does not
command. That keeps the readings flowing, so nothing has to be restarted
when the user attaches again.

## Attaching

`attach()` takes the player on the user's say-so, whatever it is doing. The
reading the driver holds describes a player somebody else was driving, so it
is dropped, along with the outstanding expectations and the stuck counts. The next
tick compares against nothing and blames nobody, then corrects the player.

## The three chip states

`AttachChip` shows one of three things, from `controlState(bridge, mode)`:

| Chip | Meaning | Control |
|---|---|---|
| **Attached** | The bridge is ready and we are driving. | Button: hand the player back. |
| **Detached** | The bridge is ready and we are not driving. | Button: take the player. |
| **No Spotify** | The bridge is not ready. | Label. |

Attached and detached are both the user's to change, so both are buttons.
With no Spotify there is nothing to hand either way, so that state is a
label.

`controlState` collapses the whole bridge lifecycle into one bit. The room
does not care whether the bridge is down, booting, or missing its debug
port; it cares whether there is a player to drive. A driver attached to a
player that is not there has nothing to be attached to, and offering a
detach button for it would be offering nothing.

## Bridge-down while attached

The mode does not change when the bridge drops. The user did not ask to be
detached, so they stay attached, and the chip shows "No Spotify" for as long
as the bridge is away.

What the driver drops is its memory: `prev`, the outstanding expectations,
and the memo of which track already has a rollover. So
whatever happened to Spotify while we were not watching — the user played
something else, the app restarted, a track ended — is corrected on the first
tick back, not attributed to anyone.

That is the right call because we have no evidence either way. `classify`
blames a user only for a change it *saw* happen between two readings. An
unobserved change is not a change it saw, and guessing would detach people
whose only crime was closing the laptop lid.
