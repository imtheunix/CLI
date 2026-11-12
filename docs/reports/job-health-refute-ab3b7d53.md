# Refute report: corrected stall alerts with synthetic job lifecycles (producer ab3b7d53)

- Refute job: 801ee02f, independent cross-family refutation by GLM Flash, 2026-11-10.
- Producer: DeepSeek, `ab3b7d537ef0a1dacca1376c6cb6d493cc2e5876` ("fix(orchestrator): deliver health alerts on real refusals, not false recovery").
- Original defects: `git show 34ceabe1:JOB_REPORT.md` (F1–F7 reproduced against `ad096ea8`/`baef1805`).
- Ancestry: `ab3b7d53` is an ancestor of this branch's HEAD (`0d15dc39`) and of `origin/main`; the checkpoint was verified as-is, not recreated. HEAD's only extra commit (`0d15dc39`, session search) touches none of the health wiring (`orchestrator.module.ts` diff is one line in a search helper call path — verified unrelated).
- Probes: `server/modules/orchestrator/tests/job-health-refute-801ee02f.test.ts` (committed, owned by this job; follows the repo's committed-probe convention, cf. `zcode-dispatch-probe.test.ts`). Synthetic lifecycles only: temp DB, temp hub-events log, injected clocks/heads, registry runs nobody dispatches, fake runtime gateway that counts and refuses every dispatch. No real model/session interaction, no network, no sleeps, no production hub events, no real job cancellation.

## Verdict: PASS

No F1/F2/F3/F5/F6 defect reproduces on `ab3b7d53`. Every re-test of the five previously reproduced defects against the real wiring behaves as the fix claims. F4 and F7 are still present exactly as the commit message declares them deferred; nothing claims them fixed. No new blocking defect found.

## Counts and commands

| Suite | Tests | Result |
| --- | --- | --- |
| `health.service.test.ts` (producer's, incl. its real-wiring tests) | 12 | pass |
| `orchestrator.test.ts` + `status.test.ts` + `usage-recovery.test.ts` | 97 | pass |
| `job-health-refute-801ee02f.test.ts` (this job's adversarial probes) | 9 | pass, stable 5× |
| **Total** | **118** | **0 failures** |

- `./node_modules/.bin/tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/job-health-refute-801ee02f.test.ts` — 9/9, repeated 5× (the F3 probes use real file mtimes and the registry's real `Date.now()`; no flakes).
- `npm run typecheck` — clean. `npm run lint` (oxlint) — 0 errors; 0 warnings in the probe file.
- Module wiring verified at HEAD: `orchestrator.module.ts:50` is `sendToJob: (job, message) => jobs.notifyWithOutcome(job, message)`.

## Probe scenarios and outcomes (all against real wiring)

**F1 — no-commit alert for a refused nudge (was feature-defeating false negative). PASS.**
- Probe: registered run busy in `chatRunRegistry` (synthetic), health wired exactly like the module (`sendToJob → jobs.notifyWithOutcome → sendTurnOutcome`), head 50 min stale on a 60-min job. `sendTurnOutcome` refuses at its busy gate (`jobs.service.ts:501`) before any dispatch; health escalates immediately: one `stalled` event, right `jobId`/title, reason `no commit for 50m`. The nudge path is attempted exactly once and never again after escalation (a refused send is never counted as delivered: `nudgedAtMs` stays null, `noCommitEventAtMs` blocks the epoch); one event per unchanged HEAD across +60 min of ticks. Runtime counters `inject`/`abort`/`run` all 0 — the refusal never steers or injects into a live model (`sendTurnOutcome` passes neither `steerActiveRun` nor `interruptActiveRun`; `runDetachedChatTurn`'s own busy refusal at `chat-websocket.service.ts:692-695` is the second layer).
- in_turn cross-talk (the original side-effect): a `notifyWithOutcome` whose send fails *after* `in_turn` was set — deterministic via the injected `probeZcode` hook registering the owning run mid-flight — keeps `in_turn: 1` while a registered run owns the session, and clears it to 0 in the identical failure when nobody owns it. Neither path aborts or injects into the owning run.
- Read-verified, not probed: the 2 s grace-timer branch (`jobs.service.ts:548-553`) needs a dispatch pending past the timer, i.e. a real pending turn. Deterministic by construction: registered run → `started: true`; otherwise `{started: false, refused: false}` → health retries next tick, never a false "delivered".

**F2 — armed-recovery false "cancel or resume" alerts. PASS.**
- Probe: `auth_required` recovery armed (valid future `dueAt`, `gaveUp: false`) with its `auth_required:` `last_error`, 21 min idle → no dead-slot event and no `dead_slot` flag (`isWaitingForHub`, `health.service.ts:79-83`, counts an armed recovery as not waiting); the `gaveUp: true` variant still fires (control).
- Residue variant through real `handleRunCompleted` (`jobs.service.ts:1075`): an armed `usage_limit` recovery + stale `usage_limit:` `last_error` after a successful non-aborted turn (exit 0) clears `last_error`, `limit_recovery` and `failure_class`; a fresh health tick emits no dead-slot for the recovered job.

**F3 — overtime labelling live long jobs stalled. PASS.**
- Probes (real clock; real `sessionsDb` row, real `runningTurnsDb` row, real file mtimes via `utimesSync`, real registry run): a 60-minute-old job with `updated_at` 60 min stale is **not** overtime while its transcript jsonl is fresh; making only the mtime 45 min stale flips it to `over 30 min: split or stop` — the transcript source is pinned in both directions. Same both-directions pin for the detached-turn source (log mtime + `started_at`) and the registry source (`startedAt` fresh → silent; registry cleared → fires). An actually idle 60-minute job with no activity anywhere fires on sight. `flags()` agrees with events in every case.

**F5 — stale event across the async read/nudge gap. PASS.**
- Probes: row cancelled, completed (`done`), or replaced (new `session_id` at the same `created_at`; new `created_at` at the same `session_id`) inside the nudge gap — all four suppress the event via the pre-emission re-read (`currentLiveJob`, `health.service.ts:142-149`). A deleted row suppresses **both** synchronous emissions (overtime and dead-slot) in the same tick. A sibling job's `readHead` flipping a dead-slot-eligible job to cancelled via raw SQL (so `updated_at` cannot mask the guard) drops the dead-slot event while the live sibling still gets its own no-commit alert (delayed by the designed 15-minute delivered-nudge grace).

**F6 — non-finite/malformed metadata. PASS.**
- Probes: `NaN` and `Infinity` `committedAtMs` from an injected reader fail closed (no nudge, no event; `health.service.ts:167-169`); garbage `created_at` → no overtime, no nudge, no crash, flags stay empty (and remain empty 50 min later); garbage `updated_at` with a failed-turn `last_error` → no dead-slot, no overtime (under-alerts, never false-alerts); missing head read → nothing; empty `worktree_path` → nothing.

**F4 — restart-unsafe cooldowns. Still present, as declared deferred (not blocking).**
- Probe: after an overtime event, a fresh service instance on the same DB/log re-emits 10 minutes later, inside the 30-minute debounce; the pre-restart instance still holds its own debounce. Health state remains the process-local `states` map; nothing seeds it from hub-events.log. hub-wake's absorption of health's `stalled` lines (`ensureStallsLoaded`, `hub-wake.service.ts:401-403`) is likewise unchanged.

**F7 — retry `created_at` intent. Unchanged, as declared deferred (not blocking).**
- Probe: `jobs.resume` on a cancelled job reactivates it with `created_at` byte-identical. Code-level: no path in `jobs.service.ts` or `orchestrator-jobs.db.ts` writes `created_at`. A retried job is immediately overtime-eligible again (now additionally moderated by the F3 activity gate); the intent decision remains open.

## False-alert / duplicate-alert assessment

- No duplicates: one no-commit event per unchanged HEAD (refusal escalation sets `noCommitEventAtMs`, blocking further nudges and events until HEAD moves — verified over +60 min of ticks); overtime and dead-slot debounced 30 min per process (verified). Delivery still flows through `appendHubEvent` → hub-events.log → hub-wake's 90 s coalescing and hub-busy gate.
- The F5 re-read makes every emission (no-commit, overtime, dead-slot) drop on cancellation, completion, deletion, or replacement (state, `created_at`, and `session_id` guards), so the refusal-escalation fast path cannot emit for work the row no longer owns.
- Conservative under-alert edges, no false alerts: F3 counts any row write (`updated_at`) as activity, so a frequently-rewritten idle row delays overtime (hub-wake still covers genuinely dead runs); malformed `updated_at` with no other activity sources disables overtime for that job; the grace-timer branch without a registered run retries rather than claims delivery.
- Legacy boolean-returning `sendToJob` injectors map `false → refused` (immediate escalation); production wiring never returns a boolean (`orchestrator.module.ts:50`), and the F5 re-read would still guard the emission.

## Limitations

- F4 and F7 remain open by design; this branch does not fix them and must not be credited with fixing them. A restart can re-emit a condition inside the 30-minute debounce, and retry `created_at` semantics still need an intent decision.
- The 2-second grace-timer branch of `sendTurnOutcome` and the behaviour of `health.tick` if `runDetachedChatTurn` ever rejects are verified by reading only (reaching either requires a real pending/throwing dispatch); both shapes are identical pre-fix, so no regression is introduced by `ab3b7d53`.
- Old pre-fix evidence (F1–F7 reproductions) applies to `ad096ea8`/`baef1805` only; none of it reproduces on `ab3b7d53`.

## Reproduction

```sh
./node_modules/.bin/tsx --tsconfig server/tsconfig.json --test \
  server/modules/orchestrator/tests/health.service.test.ts \
  server/modules/orchestrator/tests/job-health-refute-801ee02f.test.ts
```
