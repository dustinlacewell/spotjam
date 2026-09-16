# A change we did not predict is the user

The driver commands Spotify, and it predicts what Spotify does on its own.
Anything else that changes in the player is a person at the keyboard. When
that happens the driver lets go rather than fighting them for it.

`classify.ts` is that judgement, and nothing else makes it. It is pure: two
readings and the list of outstanding expectations, in; `"ok"` or `"user"`,
out.

## The rule

One clause per thing that can change between two readings.

- **`trackUri` changed.** Explained if: something outstanding predicted this
  very track — our own play of it, or the rollover registered as the last
  track ran out; or `obs.trackUri` or `prev.trackUri` is an ad; or the
  previous reading had already reached the end of its track.
- **`isPaused` changed.** Explained if: a pause/resume expectation is
  outstanding, or a play for THIS track; or the track also changed and that
  change was explained; or ad; or the player actually parked at the end of
  the track (`obs.positionMs >= obs.durationMs - 1500`) — note this asks
  about `obs`, not about `prev`.
- **Position jumped**: if `!prev.isPaused` expected = `prev.positionMs +
  (obs.at - prev.at)` else `prev.positionMs`; unexplained if
  `|obs.positionMs - expected| > 2000` and no seek that would accept this
  position is outstanding, and no play for this track, and the track did not
  change. (A stall — obs behind expected by up to the tick — never trips
  this; only a jump does.)

`prev === null` means there is nothing to compare, so there is nothing to
blame. That is why the driver forgets `prev` on a bridge outage and on
`attach()`.

## Two clauses are narrower than they look

Both narrowings are load-bearing.

**"A play is outstanding" is not enough to excuse a track change.** The user
picking their own track while our play of a different one is in flight would
be waved through, and the next tick would re-issue our play over the top of
them. Only an expectation naming the track we are actually looking at
explains it.

**The pause clause asks whether the player PARKED at the end**, not whether
the track had run out. Spotify leaving a track that was about to end is
ordinary, but a pause in that last second is a person, and excusing it means
resuming over them on the next tick. So it asks about `obs`.

## The end of a track needs no clock arithmetic here

There was a version of this file that did the arithmetic itself: it asked
whether the previous reading was near the end of its own track, and read any
move from there as Spotify's. That clause had to be tuned against the
gapless step, against autoplay, and against a player parking on the last
frame, all at once.

Now the driver registers a rollover as the track approaches its end, and
that expectation is what explains the move. One prediction covers the
gapless step into the queued next, autoplay after an empty queue, and a stop
at the end alike, because all three are "the player will leave this track"
and the rollover says exactly that.

A reading delayed across the boundary is covered for the same reason. The
rollover was registered before the stall and is still outstanding when the
late reading lands.

`parkedAtTheEnd(prev)` survives in the track clause as a backstop, for a
rollover that was never registered because the reading that would have
registered it never arrived. It is the plain, unprojected question: was the
player already at the end when we last looked?

## What the ad clause covers

An advert is not a track anyone chose, and Spotify plays one whenever it
likes. Without the ad clause a free account would detach the driver on its
own, on a change neither the user nor the driver made.

## What the position clauses cover

The 2000 ms jump slack absorbs latency. A tick is 150 ms, but a tick that
waits on a slow CDP call is longer, and the reading is stamped when it
arrives, not when the player produced it. A position falling *short* of
prediction is never a person — that is a stall, a buffer, a slow tick — so
only a genuine jump counts.

A seek only explains the position it was aiming at. One that has expired, or
that aimed somewhere else entirely, leaves a jump unaccounted for. That is
the point: the user seeking while our own seek is in flight is exactly the
case that must still be caught.

Zero is the exception to all of it. A playing track reporting 0 is Spotify
still loading, not a position. It holds there for as long as the buffer
takes — past the life of the seek that was meant to place it — and the jump
to the real position when it finally starts is the load finishing, not a
person.

## The accepted limit

A reading stall that begins **before** the 2 s window is not covered. If the
driver's last reading of a track was three seconds from the end, and the
next reading arrives after the player has already moved on, no rollover was
ever registered. `parkedAtTheEnd(prev)` is false, nothing predicted the new
track, and the driver detaches on a transition Spotify made by itself.

Widening the window would trade this for a worse fault: a rollover
registered further out is outstanding for longer, and while it is, a user
pressing Next reads as the transition it predicted. The 2 s window is the
point where a gap long enough to miss it is already a bridge that was barely
working.
