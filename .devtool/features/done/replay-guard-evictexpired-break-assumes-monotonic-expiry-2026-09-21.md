---
id: "replay-guard-evictexpired-break-assumes-monotonic-expiry-2026-09-21"
status: "done"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T18:20:00.000Z"
modified: "2026-09-21T23:35:06.151Z"
completedAt: "2026-09-21T23:35:06.151Z"
labels: ["created-by-ai", "code-quality"]
order: "a104"
---
# Replay-guard evictExpired early-break assumes monotonic expiry

Found in review of the replay-guard fix (replay-guard-expires-nonces-before-future-dated-envelopes-2026-09-21). Non-blocking there: consequences are memory/trim-quality only and the error direction is replay-safe.

`evictExpired` (apps/server/src/replay-guard.ts:74-81) walks the nonce map in insertion order and `break`s at the first surviving entry, assuming insertion order is chronological. After the retention fix, entry expiry is `max(now, timestamp) + windowMs` — not monotonic in insertion order: a future-dated envelope admitted at t0 (expiry ≈ t0+120s) sits before later entries with smaller expiries, so expired entries behind it are retained until its expiry passes, and `evictOverflow` (oldest-inserted-first, line 92) can trim a *live* nonce while an expired one lingers. The map stays bounded by `maxEntries`; retention errs toward replay safety.

Suggested fix: scan the whole map in `evictExpired` (drop the `break`) or order entries by expiry. Also correct the two now-false "Insertion order is chronological" comments (lines 31 and 75-76), which the retention fix silently invalidated.

Related: kanban t_a3cc7ce6.