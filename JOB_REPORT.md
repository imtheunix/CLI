# Job 68c52265 — refute: CLI job health alerts lifecycle safety and duplicate wakes

## Target and ancestry
- Target content: `baef180507fc841d0f94a057ed2a8d2ef19c8531` — branch `feature/cli-job-health-alerts-no-commit-45-min-o-4a21a7df` (parent job 4a21a7df), clean tree when reviewed; that worktree has since been reaped and the commit is now the tip of `origin/main`.
- Ancestry: `fc73f629` (base, also this job's base) → `ad096ea8` **feat(orchestrator): alert the hub on no-commit, overtime and dead-slot jobs** (the feature: 16 files, +685/−13, core `server/modules/orchestrator/services/health.service.ts` 253 lines + `tests/health.service.test.ts` 296 lines) → `a8a02132` fix(evals): harness job fixture `title_history` (feature-required) → `baef1805` test(websocket): refusal-frame wait (independent of the feature).
- Review method: read-only on the parent worktree until it was reaped; continued against a `git archive` copy of `baef1805` in `/tmp/refute-68c52265` (fixture only; nothing was added to the parent branch, nothing merged, no hub state touched).

## Verdict
The delivery plumbing is genuinely safe (events flow through `appendHubEvent` → hub-events.log → hub-wake coalescing, 90 s debounce, hub-busy gate, and a commit-once outbox — duplicate wakes are structurally throttled). But the health logic on top has one feature-defeating fault (F1) and two false-alert channels that can misdirect orchestration (F2, F3), plus restart-unsafe cooldowns (F4). Recommend **not treating the feature as working as committed**; minimal fixes below, or revert `ad096ea8`+`a8a02132` from main (`baef1805` is independent and can stay).

## Findings

### F1 — HIGH, feature-defeating false negative: the no-commit nudge can never be delivered to a processing session, so the 45-minute no-commit hub alert never fires in production
- Health nudges only while the job is busy (`health.service.ts:131`), and the wiring sends the nudge through `jobs.notify` → `sendTurn` (`orchestrator.module.ts:50-53`, `jobs.service.ts:484-540`). `sendTurn` does not pass `interruptActiveRun`/`steerActiveRun`, and `runDetachedChatTurn` **refuses a session whose run is processing** (`chat-websocket.service.ts:692-695`, "A run is already in progress"). A busy job's turn is always a registered running run, so `notify` returns false every tick; `nudgedAtMs` stays null forever; the `+15 min` hub event (`health.service.ts:139-147`) is unreachable for exactly the jobs the feature targets. The alert only surfaces in narrow restart-recovery windows where `in_turn=1` without a processing run.
- Side effect: each refused nudge still writes `in_turn: 0` (`jobs.service.ts:538`) on a job whose run is still processing (cleared flag on live work; repaired by the jobs tick within 3 s).
- The 2 s default-true race in `sendTurn` (`jobs.service.ts:534-537`) can also report a refused turn as `started: true` under slow DB/lookups, marking the nudge "sent" without delivery and letting the ladder proceed with no nudge at all.
- The parent test masks all of this: `health.service.test.ts:115-119` injects a `sendToJob` that always records and returns true. There is no test of the module's real wiring.
- Probe 1 (real `createJobsService` + real `runDetachedChatTurn` busy path, temp DB, registry run started like the harness does): `notify() returned: false`; `hub events after 70 busy minutes: []`; `in_turn: 0` while `registry still processing: true`.
- Minimal remediation: deliver the nudge through a path that works mid-turn — e.g. `steerActiveRun` injection into the live run for `notify`, or have health count consecutive delivery refusals and emit the hub event after N refusals instead of gating on `nudgedAtMs`. One-line guard for the cross-talk: only write `in_turn: 0` in `sendTurn` when this call set it to 1.

### F2 — MEDIUM-HIGH, false alerts: jobs with an armed auto-recovery (explicitly kept silent by design) get repeated "holding a slot: cancel or resume" hub wakes
- `isWaitingForHub` (`health.service.ts:71-74`) treats **any** `last_error` as waiting-for-the-hub. But `handleLimitFailure` writes `last_error: 'usage_limit: …'`/`'auth_required: …'` for armed recoveries whose auto-resume is scheduled (`jobs.service.ts:363,397`) and whose design comment says: "an armed usage-limit or transient retry is silent (a 429 must not wake the hub on every capacity blip)" (`jobs.service.ts:368-369`) with "one hub wake per login wait" (`jobs.service.ts:370`). Health defeats that: a job waiting out a quota reset with a working recovery plan is reported `stalled` at 20 min and every 30 min until the reset — often hours.
- Residue variant: `jobs.service.ts:1098` clears `last_error` after a successful turn only when it starts with `'The last turn ended with exit code'`, so a `usage_limit:`/`auth_required:` error survives a successful post-recovery turn and keeps the dead-slot alarm firing for a healthy job.
- Probes 2 and 3: armed-recovery job → `"holding a slot: cancel or resume (21m)"`, repeated at 52 m; recovered job whose last turn succeeded → same event.
- Minimal remediation: in `isWaitingForHub`, an armed (not `gaveUp`) recovery must count as NOT waiting for the hub; in `jobs.service.ts:1098`, clear any `last_error` on a successful, non-aborted turn (not just exit-code-prefixed ones).

### F3 — MEDIUM, false "stalled" classification: overtime reports healthy jobs with live provider activity as `stalled` every 30 minutes, forever
- `checkOvertime` (`health.service.ts:150-164`) requires neither busyness nor activity: `state: 'stalled'`, reason "over 30 min: split or stop", keyed to `created_at`, which nothing resets — a multi-day job (normal in this repo) is woken every 30 minutes for its whole life. Defaults make it worse: `maxRunMin=30` < `noCommitMin=45`, so overtime preempts the nudge ladder and the hub hears "stalled" before the feature's own gentle nudge could run. The refute focus says >30-minute running jobs with live provider activity must not be falsely declared dead/stalled; with state `'stalled'` they are — hub-wake formats them identically to real transcript stalls (`hub-wake.service.ts:127-128`).
- Probe 7: live registry run + fresh-ish HEAD, 31-minute job → `"over 30 min: split or stop"` while the no-commit nudge had not even been attempted; nudge only at 51 min.
- Minimal remediation: gate `checkOvertime` on stale provider activity (reuse hub-wake's `lastActivityMs` sources), or emit a dedicated non-`stalled` state (e.g. `overtime`) so live work is not classified with dead work; reconcile `maxRunMin` vs `noCommitMin` ordering in the defaults.

### F4 — MEDIUM-LOW, cooldowns do not survive a restart; health 'stalled' lines also pollute hub-wake's stall dedup
- All cooldowns live in the in-memory `states` map (`health.service.ts:97`); nothing is persisted. The commit message's "capped at one per job per condition per 30 minutes" is process-local: after a restart the same condition re-fires within minutes (probe 4: two overtime events 5 minutes apart across a simulated restart). hub-wake persists its own dedup (file + appConfig + log reconstruction, `hub-wake.service.ts:359-433`); health does not.
- Cross-contamination: `ensureStallsLoaded` reconstructs `lastStallEmitted` from **all** `\tstalled\t` lines regardless of origin (`hub-wake.service.ts:394-414`), so health's no-commit/overtime/dead-slot events are absorbed into hub-wake's stall-suppression state on restart.
- Minimal remediation: seed health's per-condition timestamps at construction from hub-events.log (same reconstruction pattern hub-wake uses), or persist them to appConfig.

### F5 — LOW, cancellation/completion race: the hub event is appended without re-reading the row
- `checkNoCommit` operates on the tick's snapshot across two async gaps (`readHead` git call, then the awaited nudge) and appends the event (`health.service.ts:141-147`) with no fresh state check. The nudge path re-checks `cancelled` (`jobs.service.ts:491`, `chat-websocket.service.ts:669-671`), the event path does not. Probe 5: job cancelled inside the `readHead` gap still received `"no commit for 66m"`. Window is one async git call per job per tick — small, but it is exactly the "wake for wrong work" case.
- Minimal remediation: re-read `orchestratorJobsDb.get(job.id)` immediately before each `appendHubEvent` and drop the event unless the row is still `active`/`preparing` (same guard before the nudge send for symmetry).

### F6 — LOW, robustness (not production-reachable today)
- Non-finite `committedAtMs` through an injected `readHead` → `headSinceMs` becomes NaN in `resetNoCommit` (`health.service.ts:116-122`) and the `< noCommitMs` guard is vacuously false → immediate nudge (probe 6). The production `defaultReadHead` guards with `Number.isFinite` (`health.service.ts:76-85`), so this needs an injected reader; a one-line `Number.isFinite(head.committedAtMs)` check makes it structural.
- Malformed metadata fails safe (verified): garbage `created_at`/`updated_at` emit nothing and produce no flags; missing head read emits nothing; empty `worktree_path` skips (the column is NOT NULL, so only `''` reaches that guard). Config overrides accept only finite >0 numbers (`orchestrator-config.service.ts:377-384`).

### F7 — Informational / design notes (no fault demonstrated)
- Same-row retries: `retry` resets state to `queued` but not `created_at` (`jobs.service.ts:961`), so a retried job is immediately overtime again (30-min debounce continuing across the retry boundary); a stale `nudgedAtMs` from before the retry can fire the no-commit event on the retry's first busy tick when HEAD did not move. Defensible readings exist (job-lifetime budget vs run budget); needs an intent decision, not a bugfix.
- Finished rows never emit: overtime/dead-slot gate on `active`/`preparing`; merge failures keep their owner (merge-queue emits `merge_failed`/`blocked` itself; health never does), so ownership does not vanish from health/status tracking.
- Dead-slot timing uses `updated_at`, which any row write bumps (`orchestrator-jobs.db.ts:221`) — conservative (under-alerts), acceptable.
- `rename` is JSON-robust (`readTitleHistory` catch → `[]`), rejects empty titles, and is covered by tests; `tjob status` renders health flags defensively (`j.get("health")`).
- `minutes()` clamps to ≥1 and flags can render before the first tick (head-since initialized from `created_at`) — cosmetic.

## Tests and probes (exact counts)
- Existing parent tests of the touched files, run unmodified in the `/tmp` copy of `baef1805`:
  - `server/modules/orchestrator/tests/health.service.test.ts` — 6/6 pass.
  - `status.test.ts` + `tjob.cli.test.ts` + `orchestrator-job-usage.test.ts` — 17/17 pass.
  - `server/modules/websocket/tests/chat-edit-send.test.ts` (touched by `baef1805`) — 9/9 pass.
  - Total: 32/32 pass. All green — and none of them exercise the real nudge wiring, which is why F1–F5 exist.
- Focused probes (fixture-only file `server/modules/orchestrator/tests/refute-68c52265.probe.test.ts` in `/tmp/refute-68c52265`, temp DB + temp events log, fake runtime, no production contact, no outbound requests): 7/7 demonstrated real target-code behavior — P1 real-notify refusal kills the ladder (plus `in_turn` cross-talk), P2 armed-recovery dead-slot ×2, P3 stale-error dead-slot after success, P4 restart re-emit 5 min apart, P5 event appended for a job cancelled mid-tick, P6 garbage metadata safe / NaN head immediate nudge, P7 live 31-min job told "stalled" pre-nudge.
- Reproduction: `git archive baef1805 | tar -x -C /tmp/refute-68c52265`, link `node_modules`, then `cd /tmp/refute-68c52265 && ./node_modules/.bin/tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/refute-68c52265.probe.test.ts`. (Probe file kept out of the repository per this job's read-only brief.)

## Revert assessment
- If the hub chooses revert over fix: revert `ad096ea8` and `a8a02132` together (the evals fixture fills the `title_history` column the feature's schema migration adds). `baef1805` (websocket test wait) is unrelated and safe to keep. Since `baef1805` is already `origin/main`, a revert lands as a new commit on main; the CI queue owns that path.
- If fixing instead: F2 and F1 are small, localized changes (`isWaitingForHub` + `jobs.service.ts:1098` + the `sendToJob` wiring/steer path); F3 wants an intent call (activity gate vs new event state) before code; F4/F5 are small guards. F1's existing test should be extended to wire the real `jobs.notify` so the masked path cannot regress silently.

# Job d10ec06c — CLI: F4 health cooldown persistence, exact focused tests

## Scope and ancestry
- Supersedes cancelled `bab94074`; starts from its `fb9c56c0` on fresh `origin/main` (`cac72b11`), reapplied as `03097083` (FB9's parent was already `cac72b11`, so the change is the same six files).
- Scope limited to F4: orchestrator `health.service` restart-safe cooldowns, the `health` hub event state, `hub-wake` formatting/dedup, and the exact tests of those files. No watcher code, no test disabling, no system-limit changes, no server restart or live provider.

## What changed
- Per-job, per-condition `deliveredAt` cooldowns persist in `app_config` under `orchestrator.job_health_cooldowns` (`{version:1, cooldowns:{'<jobId>:<condition>':{at,marker}}}`).
- Episode markers: HEAD sha (`no_commit`), `created_at` (`overtime`), `updated_at` (`dead_slot`). A restart inside the 30-minute debounce with the same marker does not re-emit; a changed marker starts a fresh episode, so the old cooldown no longer suppresses it.
- Health alerts emit HubEventState `health` (rendered as `stalled, <reason>`), so `hub-wake`'s stall-dedup reconstruction never absorbs them.
- Persistence is injectable (`cooldownPersistence`); a failed save keeps the in-process debounce and never spams.

## Verification (focused only, per brief)
- `health.service.test.ts` + `hub-wake.service.test.ts` + `job-health-refute-801ee02f.test.ts` + `orchestrator.test.ts`: **138/138 pass** (`tsx --tsconfig server/tsconfig.json --test`, 75.9 s).
- Added two explicit episode tests: a changed `created_at` marker expires the persisted overtime cooldown after restart; a changed HEAD sha starts a fresh no-commit episode after restart (old cooldown does not suppress it).
- `tsc --noEmit -p server/tsconfig.json`: clean. `oxlint` on the six touched files: clean.

## Watcher host limit (separate, not modified here)
- The earlier merge failure was not this code: `server/modules/providers/tests/sessions-watcher-native.test.ts` had five timeouts then four cancellations with `ENOSPC` — the host had exhausted its inotify watcher instances. That is a machine/host limit, not a code or test defect. This job ran no watcher tests and changed neither watcher code nor limits. CI's full gate will still exercise those tests; if `ENOSPC` recurs there, raise the host's `fs.inotify.max_user_watches`/`max_user_instances`.
