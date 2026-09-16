# The driver is a reconciler

`PlaybackDriver` in `apps/desktop/src/lib/playback/driver.ts` makes the
local Spotify client play what the room is playing. It is level-triggered.
Every 150 ms it reads the player, computes what the room wants, and commands
the difference.

It remembers almost nothing. There are no phases, no "we are starting a
track" state, no "waiting for the transition" state. Each tick asks the same
question of the current pair of pictures and gets the same answer.

## The tick

1. If the bridge is not `ready`, forget everything learnt about the player
   and stop. A bridge that is not ready rejects every command, and the
   player it would have described is not ours to reason about.
2. Read the player: `spotify_observe` gives the track, the pause flag, the
   position, the duration and the head of Spotify's own one-slot queue.
3. If the track is within 2 s of its end, register a rollover — the
   prediction that Spotify is about to move by itself. This happens before
   anything judges or prunes, so the prediction is in the list for the very
   reading that first shows the transition.
4. Prune the outstanding expectations against that reading.
5. If attached, classify the reading against the previous one. If it says
   the user acted, detach and issue nothing.
6. Compute `desired` from the room pointer on the server clock.
7. `reconcile(desired, obs, outstanding)` returns the commands that close
   the gap. Issue them, and record an expectation for each.

Ticks also fire when the room changes and when the bridge becomes ready.
A tick arriving while one runs sets a dirty flag and runs after it, rather
than overlapping: two ticks in flight would read a player that the other
one's commands have not reached yet.

## Desired

`desiredAt` in `desired.ts` takes the room pointer, the session queue and
`serverNow()`, and returns either `idle` or a track with a position, a
pause flag and the URI that belongs in Spotify's next slot.

It runs `settleOnce` first. A snapshot is only as fresh as the last one
that arrived, so a pointer whose track has already ended is stepped one
place forward before anything is read from it. The client plays the next
track the moment the old one ends, and it does not invent a different
answer than the server's — it runs the same pure function the server runs.

## Reconcile

`reconcile` is pure. No memo, no clock, no memory of what it applied last
tick. It orders its concerns: track, then play state, then position.
Nothing below the track matters while Spotify is on the wrong one, because
that player's pause flag and position belong to a track we are about to
leave. An advert short-circuits the whole transport: it is Spotify's own
business and ends by itself, and correcting against it would fight the ad
break for its whole length.

Each branch issues one thing. `startTrack` plays and nothing else — no seek
and no pause bundled with it, because a seek that reaches Spotify while the
track is still loading lands on nothing and is lost, and counts as in flight
while it is gone, blocking the drift correction that would have placed the
track properly. `correctDrift` runs a tick or two later and does the placing,
and because it is level-triggered it retries, which is what makes a dropped
seek recoverable at all.

`reconcile` also keeps Spotify's one-slot queue equal to the head of the
session queue, so the player transitions gaplessly into the right track by
itself. An empty head clears the slot, which stops Spotify's own autoplay
inventing a track for a room that has none. The slot is reconciled whatever
the transport is doing — it is the one thing still worth getting right on a
track that is ending, on an advert, and on a track that will not start.

## The end of a track is not a special case

`reconcile` has no boundary rule. It does not ask whether the track is about
to end, and it does not project the pointer forward to guess what comes next.

The rollover does that work, as an ordinary expectation. While one is
outstanding, two things follow from rules `reconcile` already had:

- `startTrack` will not play the track the rollover names, because
  `arriving` reports it as already on its way. Playing it on top of a
  transition about to reach it plays it twice.
- `queueCommands` will not touch the slot the rollover is counting on. Our
  clock reaches the next item a beat before the player does, and at that
  moment the room wants the slot cleared — but clearing it is exactly how the
  seamless step we are waiting for gets cancelled. A tick later the
  transition has happened and the slot is reconciled against the room as
  usual.

When the rollover expires the transition did not come, and the next tick
plays the track by the ordinary path. Nothing in `reconcile` knows any of
this happened.

## Why level-triggered

The layer this replaced was edge-triggered. It inferred the end of a track
from Spotify, used Spotify's gapless transition as a signal, and inferred
who controlled the player from an unexpected track. Each inference needed a
grace window to survive the others, and every seam — a dropped socket, a
reload, a paused app — left the client stranded in a phase nobody would
leave.

A reconciler has no seams to strand it. It does not care how the player got
where it is. If the picture is wrong, the next tick corrects it, whatever
happened in between and however long ago.

That is also why the driver forgets everything whenever the bridge goes
away. When the bridge comes back, the first tick compares against nothing,
so it corrects the player instead of blaming the user for the gap.

## The rollover is a prediction, not a phase

A rollover has a deadline, so it is fair to ask whether it is the old
edge-triggered design creeping back.

It is not, and the difference is that it expires into the ordinary path. A
phase is a state the loop must be got out of, and getting it wrong strands
the client. A rollover is a claim about what the player will do. If the
claim comes true, it leaves the list. If it does not, it leaves the list
anyway, and the next tick sees the same gap it would have seen if the
rollover had never existed and closes it the same way.

Nothing branches on "are we in a transition". `reconcile` and `classify`
both ask the same question they always asked — does something outstanding
account for this — and a rollover is just one more thing that can.

## The invariant

While attached and the bridge is ready, at every tick one of these holds:

- Spotify matches `desired` within tolerance, or
- an expectation aimed at `desired` is outstanding — a command we issued, or
  a rollover predicting the move Spotify is about to make, or
- the driver detached, because Spotify changed in a way we neither
  commanded nor predicted.

Everything else in this folder exists to keep that true.
