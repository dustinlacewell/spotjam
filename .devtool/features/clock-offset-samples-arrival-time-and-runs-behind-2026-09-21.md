---
id: "clock-offset-samples-arrival-time-and-runs-behind-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:52.756Z"
completedAt: null
labels: ["created-by-ai", "sync", "bug"]
order: "a204"
---
# Clock offset is measured at frame arrival, so every client runs systematically behind

The offset sample (`serverTime − localNow`) compares the server clock
*at snapshot creation* against the local clock *after one network hop*:
the sample is folded at packages/room/src/lib/room-client.ts:215 using
`localNow` = arrival time (apps/desktop/src/lib/room.ts:181), measured
in packages/room/src/lib/clock-offset.ts:25-29. There is no RTT/2 or
send-time correction anywhere, and the mean blend (`OFFSET_ALPHA`)
locks the bias in as the steady-state value.

Failure mode: every listener's position read (and their local transport
actions' notion of "now" in the server frame) lags the broadcaster by
the client→server latency; on a slow link the "up next" track visibly
fires late.

Fix: at minimum subtract measured message latency (timestamp at send on
the server; receipt time plus half-RTT on the client), and/or use
min-offset-over-window rather than a mean blend.