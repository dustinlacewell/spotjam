---
id: "direct-play-adopts-a-doubled-track-length-and-skips-are-dead-2026-09-21"
status: "todo"
priority: "critical"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T02:40:00.000Z"
modified: "2026-09-21T06:09:31.875Z"
completedAt: null
labels: ["created-by-ai", "sync", "bridge", "bug"]
order: "a4"
---
# Direct-play adoption mints a doubled track length; skipping is dead in both directions

Reproduced live on Spotify client 1.2.95 (2026-09-21, "Open Road", true length 449,000 ms):

- Room seek bar reads `pointer.durationMs` (server snapshot) as **897,750 ms = 14:57** — exactly `449,000 + 448,750`, i.e. the item metadata duration PLUS the player-state duration. The bar advances at normal speed and the song ends halfway through it.
- Skipping does nothing in either direction: seeking from the bar does not reach the client, and skipping in the client does not move the UI.

Probe evidence (scripts attached to the orchestrator's review of card t_7f9066b1, runnable against the live client over CDP 9222):

- `window.__playerApi.getState().duration` = 448,750 — a plain number, CORRECT. The state path is not the doubling source.
- `getState().item.duration` = `{ milliseconds: 449000 }` — a nested OBJECT in this client version (shape change vs the plain number the bridge expects in `player_api.rs` `STATE_EXPR_JS`, which reads `s?.duration` only — that path is fine for duration).
- `getState().positionAsOfTimestamp` = **0 while playing** — the bridge computes `positionMs = base + (Date.now() - s.timestamp)`, so with base stuck at 0 the position degenerates to "time since the getState call". This plausibly explains the dead skips (reconcile always sees a near-zero position and/or sends seeks the client ignores) and needs verification — do not assume.
- Client-side queue storage had plausible (not doubled) durations for its items, so the doubling is not the stored-queue path — it is minted in whatever mints the enqueue/pointer for a DIRECTLY PLAYED track (the broadcaster follows a user-driven player change; see docs/desktop/playback/a-change-we-did-not-predict-is-the-user.md).

Two questions, both need answers with the live client attached:

1. Where is the enqueue op that carries 897,750 minted? (Both duration sources must be in scope in one code path — find it, fix the sum.)
2. Is `positionAsOfTimestamp: 0` a client 1.2.95 getState shape change (fields renamed/moved), and does the STATE_EXPR need updating? This may also explain "skipping in the client does nothing": if the driver's position reads degenerate, its reconcile logic misjudges. Verify against the actual state object shape, not against the 1.2.65-era assumptions in the tests.