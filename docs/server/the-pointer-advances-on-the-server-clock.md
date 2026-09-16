# The pointer advances on the server clock

The room's playback pointer is a pure function of time. Give it a start
instant, a duration and a `now`, and you get the position. Nothing else
decides where the room is.

The server holds that pointer. No client tells it that a track ended, and
no client tells it how far along a track is. Both used to happen. Both are
gone.

## Why no client reports an end or a progress

A client report is a message, and a message can be late, lost, duplicated
or wrong. The room then has to decide which report to believe, which needs
grace windows, which need each other. A broadcaster who quit mid-track
stranded the room, because the only actor who could say "this track is
over" had left.

Time does not need a message. Every member computes the same position from
the same pointer, because `positionAt` is the same pure function on both
sides of the wire. A member who leaves takes nothing with them.

## The duration is load-bearing

`positionAt` and `endsAt` read `durationMs` off the pointer, so the whole
mechanism rests on it. A missing, zero or fractional duration would stall
the room or leave the clock chasing a boundary it can never land on.

So `QueueItem` and `PlaylistTrack` both carry `durationMs`, and the server
refuses an enqueue without one — `isDuration` in `handle-op.ts` demands a
positive integer. The client resolves a track's length before it enqueues,
and drops a track whose length will not resolve rather than queue it at
zero.

## Settle before every op

`handleOp` runs `Room.settle` before it applies anything. `settle` steps
the pointer forward while its track has run out, handing each next track
the exact instant the last one ended, so the clock stays continuous and a
run of short tracks is crossed in one call.

The op must land on the track that is really playing, not on the one that
was playing when the last snapshot went out. Doing this once in `handleOp`,
rather than inside each op, means no op that gets added later can forget to.

`settleStart` runs after. It is the mirror: `settle` empties a pointer the
room can no longer justify, `settleStart` fills a null pointer the room can
now feed. The server, not a client, decides when a room with a broadcaster
and a queue starts playing.

## The room clock

Settling on ops is not enough. A room where nobody does anything still has
to move from one track to the next.

`RoomClock` holds at most one timer per room, set for the instant the
pointed track runs out. When it fires it settles, commits, and publishes —
the same path an op takes, so a member cannot tell a track change from a
skip.

`Session#publish` arms the timer. Every committed change reaches `publish`,
so no path can move the pointer without the clock hearing about it. A pause,
a seek, a skip or a deserted room replaces or drops the earlier timer rather
than leaving it to fire on facts that no longer hold.

A boundary already behind us still fires, on the next tick. A settle that
lands exactly on an end leaves the next track due immediately, and a
negative delay is how a host spells "as soon as you can".

The clock and the timer pair are injected. A test drives the real behaviour
with fakes and no waiting.
