# Expectations are the only memory

A reconciler that remembered nothing would issue the same command every
tick. Spotify takes a moment to obey: it reports the old track for most of
a second after a play, and the old position after a seek. During that moment
the reconciler still sees a gap and would fire again, six or seven times a
second, into a player already doing the right thing.

So the driver keeps one list: what it is waiting for the player to do. That
is its whole memory. `expectations.ts` owns it.

## Not everything in the list was asked for

Spotify ends a track and steps into the next one on its own. That is every
bit as predictable as a command — it just has no command behind it.

A `rollover` is that prediction, and it lives in the same list. Holding it
there means the rest of the system needs no special case for the end of a
track. The change is explained because something outstanding predicted it,
which is the only rule there has ever been here.

So an expectation waits on one of two things: a `Command` we sent, or a
`Rollover` Spotify is about to make.

## What an expectation is

A thing awaited, the instant it was registered, and a deadline. It leaves
the list in one of two ways.

**It holds.** `holds(e, obs)` asks whether the reading shows what was
predicted. A play holds when the track URI matches. A pause holds when the
player is paused. A seek holds when the position is within 3 s of its
target, allowing for time passing, because a playing track keeps moving
after the seek arrives.

**Its deadline passes.** A transport command gets 3 s. A queue-slot command
gets 1.5 s, because it is local to the client and answers much faster.

`prune` splits the list three ways against one reading: kept, landed,
expired.

## The rollover

`rolloverFor(obs, now)` builds one from a reading. It carries `uri` — the
head of Spotify's own queue, where the player should land — and `from`, the
track it was registered against.

An empty slot gives a null `uri`. We then know only that the player will
leave `from`, by autoplay or by stopping. `from` is what makes such a
rollover checkable at all: `holds` asks whether the track is no longer
`from`, whatever it went to.

The deadline is the track's own end **as Spotify reports it**, plus 1.5 s.
Not our clock. The whole point of the expectation is that the two disagree
by a beat, and the player's own remaining time is the only honest estimate
of when it will move. A transition that has not happened by then is one that
is not coming, so it expires and the driver plays the track itself.

## Who registers it, and when

The driver, in `watchForRollover`, before anything judges or prunes the
reading. So the prediction is already in the list for the very reading that
first shows the transition.

The window is `ROLLOVER_WINDOW_MS = 2000`: the player is within 2 s of the
end of its track, playing, with a real duration. That is wider than the 1.5 s
slack the expectation itself allows, so the prediction is registered before
Spotify could plausibly act on it, even when the two clocks disagree.

One per track. A memo of the track it was registered for stops a fresh
rollover being made on every tick of those last two seconds, and it clears
when the player moves on — the next track earns its own prediction when it
reaches its own end.

## What the list does

Three readers ask it three different questions.

`arriving(list, uri)` — is this track already on its way onto the player?
Either we asked for it and the play has not landed, or Spotify is about to
step into it alone. Both mean the same thing to `reconcile`: do not start
it, it is coming. A rollover with no known destination promises no
particular track, so it answers for none.

`pending(list, kind)` — is a command of this kind outstanding? This is how
`reconcile` stops re-issuing a pause, a resume, a seek or a queue write.

`classify` asks the expectations themselves. It looks for a play naming the
track it is looking at, a seek that would accept the position it is looking
at, or a rollover whose `holds` is satisfied by this very reading — the same
question `prune` asks a moment later.

The order matters. The driver hands `classify` the list *as it stood when
the reading arrived*, and hands `reconcile` the pruned one. An expectation is
pruned precisely because the change it predicted has now happened, which is
the very change `classify` is about to judge, so it has to still see it.

## Why a command that never landed is re-issued

Nothing acknowledges a command. The bridge returns when the CDP call
returns, which says the page took the call, not that the player obeyed. A
play can be swallowed by a buffering client or a page mid-reload.

When the deadline passes, the expectation leaves and the gap is still there.
The next tick sees it and issues the command again. No retry logic, no
backoff table: re-issue is what a level-triggered loop does by default, and
the expectation's only job was to suppress it while the first attempt was
still plausible.

The same is true of an expired rollover. The transition did not come, so the
next tick sees the wrong track and plays the right one by the ordinary path.

## Stuck

Re-issuing forever is wrong for a target that will never work. A track
pulled from the catalogue, or a region-locked one, never starts. The play
expires, the next tick sees the same gap, and the room wedges there making a
request a second for as long as the pointer sits on that track.

`stuck.ts` counts consecutive expirations per target, and past the limit
`reconcile` stops issuing that target's commands. Any success clears the
count — a command that landed is proof the target works.

The verdict is not permanent. A target is keyed by what it asks for, a URI
or a position, so a verdict would otherwise outlive its own reason: a track
that failed once because the network was down would stay silent for the rest
of the session, including when somebody queues it again an hour later. So
entries age out, and the driver drops the whole set when the pointer moves
to a different item.

**A rollover never counts toward stuck.** `commandsOf` filters rollovers out
of both the landed and the expired lists before they reach `recordSuccess`
and `recordExpired`. Nothing was sent, so there is nothing to judge, and a
transition that did not happen says nothing about whether a track can be
played.

The stuck set is published to the UI, so the room can say which track
Spotify would not take rather than sitting silent on it.
