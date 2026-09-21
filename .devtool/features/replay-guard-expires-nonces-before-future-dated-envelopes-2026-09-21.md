---
id: "replay-guard-expires-nonces-before-future-dated-envelopes-2026-09-21"
status: "backlog"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T04:13:10.000Z"
modified: "2026-09-21T04:17:46.171Z"
completedAt: null
labels: ["created-by-ai", "protocol", "bug"]
order: "a21"
---
# Replay guard evicts nonces before future-dated envelopes stop being replayable

`admit()` (apps/server/src/replay-guard.ts:46-54) records the nonce with
`now` = *arrival time*; `evictExpired` drops it at
`arrival + REPLAY_WINDOW_MS`. But `open()`
(packages/protocol/src/envelope.ts:116-118) accepts envelopes dated up
to 60 s in the future (`future-timestamp` bound), and such an envelope
stays signature-valid until `timestamp + windowMs` — up to 60 s *after*
its nonce entry has been evicted. A captured future-dated envelope can
be replayed in that gap and is accepted as fresh.

Failure mode: any signed op (enqueue, seek, skip, playlist replace) can
be replayed up to ~60 s past the point the design says it is dead.

Fix: record each nonce's expiry as `max(now, timestamp) + windowMs`, or
cap the accepted future skew to something small and keep the guard's
window aligned to the later of arrival vs. timestamp.