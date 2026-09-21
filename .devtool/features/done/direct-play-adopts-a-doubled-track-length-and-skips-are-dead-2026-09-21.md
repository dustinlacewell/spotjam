---
id: "direct-play-adopts-a-doubled-track-length-and-skips-are-dead-2026-09-21"
status: "done"
priority: "critical"
assignee: null
epic: null
dueDate: null
created: "2026-09-21T02:40:00.000Z"
modified: "2026-09-21T07:51:58.258Z"
completedAt: "2026-09-21T07:51:58.258Z"
labels: ["created-by-ai", "sync", "bridge", "bug"]
order: "a1G"
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

## Findings (2026-09-21, probed live on client 1.2.95)

**Q1 — the doubling is not a repo-side sum; it is the metadata decode.** No code path anywhere in the repo adds two durations. The TRACK_V4 message the client's `_metadataExtensionsAPI.fetch` returns carries `Track.duration` (tag 7) as a **zigzag `sint32`** varint, and the bridge decoded it as plain `int32` (`track_api.rs`), which doubles every positive value. Live evidence: raw varint 640,200 → 320,100 ms for `2zKrt7YUpsKWEQagjS4rOQ` (its `getState().duration` is exactly 320,100); raw 717,650 → 358,825 for `582gpRUX6LEVXbuCdgIDaq` (`getState().duration` exactly 358,825, and the client plays it in ~6 minutes). The card's original arithmetic (449,000 + 448,750 = 897,750) was coincidence: zigzag-decoded, 897,750 = 448,875 ms — the true length. The enqueue path (`withDurations` → `spotify_fetch_tracks`) is the only mint, and it inherited the doubled decode; the pinned fixture in `track_api.rs` enshrined a doubled value all along. Fix: read tag 7 as `sint32`; the regression test pins 358,825 against 717,650.

**Q2 — `positionAsOfTimestamp` needs no STATE_EXPR change.** Verified live: while playing, the state object does not refresh — `positionAsOfTimestamp` and `timestamp` freeze together at the last transport event (play/resume/seek). That frozen pair is exactly "position X at time T", so the bridge's `base + (now − timestamp)` still yields the correct elapsed position; confirmed by resuming (base 278 at T) and pausing 4.2 s later (base 15,325 ≈ 278 + 4.2 s). `getState()` immediately after a play may return the *previous* track's stale state (one-tick lag, harmless at the driver's 150 ms poll). `s?.duration` is still a plain number; `s?.item?.duration` is now a nested `{milliseconds}` object but STATE_EXPR never reads it.

**Skips.** `seekTo` works live on 1.2.95 (base jumps to the target, `timestamp` rebases to the seek event). Server-side seek/pause ops move the pointer (observed live via a read-only peer against the deployed server). The dead-skip symptom follows the doubled duration: the room's positions ran on a 2× scale, so reconcile aimed seeks past the true end of the track. End-to-end room-UI → client relay could not be observed live: the app webview is WebKitGTK (no CDP — see docs/desktop/debugging-the-app.md), the driver on the running instance is currently detached ("user-took-player" from earlier direct plays), and the running app predates this fix. A rebuilt app with the driver attached is needed for a full live skip test.