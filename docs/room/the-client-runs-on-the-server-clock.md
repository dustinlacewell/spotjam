# The client runs on the server clock

The pointer is a pure function of time, and the time it is a function of is
the server's. `positionAt(pointer, now)` is only correct when `now` is in
the server's frame.

A client's own clock is not in that frame. It can be seconds off, and some
are minutes off. So the room client keeps an offset and converts.

## The fold

Every `room-state` snapshot carries `serverTime`. `foldOffset` turns one of
those into an offset:

```
sample = serverTime - localNow
```

`localNow` is this machine's clock at the moment the frame arrived. The
first sample is taken whole; there is nothing to blend with, and a client
that waited for convergence would draw a wrong bar until it came. Every
sample after is blended at `OFFSET_ALPHA = 0.2`.

The blend exists because a single sample carries the whole round trip's
jitter. A raw swap makes the progress bar stutter as one late frame drags
the offset and the next one drags it back. At 0.2 the offset converges in a
handful of snapshots and ignores one late frame.

`foldOffset` and `serverNow` are pure. No clock is read in that file; the
shell passes `localNow` in. `serverNowOf(view, localNow)` is how everything
else asks the question, and `Room.serverNow()` is the port method the driver
and the UI both use.

## The progress bar reads the settled pointer

`QueueView` does not track the position. It computes it:

```
const serverNow = room.serverNow();
const settled = settleOnce(pointer, sessionQueue[0] ?? null, serverNow);
const positionMs = positionAt(settled, serverNow);
```

The settle is there because snapshots arrive in bursts. Between two of them
a track can run out, and an unsettled pointer would stick at the end of the
old track until the next snapshot landed. Settling one step forward rolls
the bar onto the next track on time.

This is a view of the pointer, not a decision. The server still owns what
actually plays, and the client runs the same `settleOnce` the server runs,
so it cannot arrive at a different answer.

The bar is the same computation the driver's `desiredAt` makes. Neither one
reports anything to the other, and neither can drift from the other, because
both are the same pure function of the same pointer on the same clock.

## Why one-way latency does not matter

The offset conflates the true clock difference with the one-way trip: a
snapshot that took 80 ms to arrive makes the offset 80 ms low. Nothing
corrects for that, and nothing needs to.

The numbers this feeds are compared against tolerances that dwarf it. The
driver seeks only when the player is more than 3 s off the desired position.
`classify` calls a position change a jump past 2 s. The progress bar renders
to the second. A few tens of milliseconds of one-way latency is invisible
at every one of those thresholds.

A round-trip estimate would cost a request/reply pair per sample and buy
accuracy nothing reads.
