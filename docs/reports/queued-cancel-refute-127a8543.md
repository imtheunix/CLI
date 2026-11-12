# Refute report: queued-job cancellation before the push (producer 127a8543)

- Review job: dfa274f4, independent adversarial review by GLM Flash, 2026-11-10.
- Producer tip under review: `127a854381b9074b5557a0af1f0bcd722d0dffb5` ("fix(orchestrator): cancel a queued job without a wired merge queue") on top of `346febf2a432e1e1994becbf38cb4d6261e0e7c5` ("feat(orchestrator): tjob cancel withdraws a job from the merge queue before the push"); producer job a84d0596.
- Ancestry: both commits are on `origin/main` (127a8543 is current `origin/main` HEAD); reviewed as merged, nothing recreated. No production file was modified by this job; the only artifact besides this report is a new committed probe file.
- Probes: `server/modules/orchestrator/tests/queued-cancel-refute-dfa274f4.test.ts` (13 probes, committed on this branch). Every probe drives the real wired composition — a jobs service whose `withdrawFromMergeQueue` is a real `createMergeQueueService().cancel`, wired exactly like `orchestrator.module.ts:45-51` — against an isolated temporary SQLite database, a bare origin, a clone and real worktrees. In-flight stages use fixture-owned real children (`tail -f /dev/null` under `exec`) held open until the probe cancels them, or controlled promises that never spawn at all; readiness waits are bounded condition polls, never sleeps. Fixture-owned pids are killed by pid/group in `finally`, so even a failing probe cannot leak a blocked child. No production DB, no real queue, no credentials, no network (the Forgejo token file points nowhere, so a pushed job merges without CI), no service restart.

## Verdict: PASS

No reproduced defect. The first gate's real failure (an undefined withdrawal callback treated as a queue refusal at `jobs.service.ts:1003`) is genuinely fixed by 127a8543: the standalone path, the wired-success path, the wired-refusal path and the wired-exception path are now four distinct behaviors, and each was probed against the real services. The full risky change surface — wiring, transition contract, token barriers around in-flight rebase/check, pid tracking and group kill, DB update, step history, hub event/wake, workspace cleanup, push replay after shutdown — behaves as designed, and the pre-existing adversarial suites still pass. Four observations below are bounded or unreachable-in-production; none is a new defect, none justifies a HOLD.

## Method

1. Read both commits' full diffs, then the current state of every touched file (`jobs.service.ts`, `merge-queue.service.ts`, `orchestrator.module.ts`, `orchestrator-jobs.db.ts`, `hub-events.service.ts`, `hub-wake.service.ts`, `workspace.service.ts`, `scripts/tjob`) plus the consumers that bound correctness: `orchestrator.routes.ts` (thin route, 409 passthrough), `listInMergeQueue` (the tick's source of truth), `cleanup.service.ts` (what a cancelled job's disposal removes), `cleanup.test.ts`.
2. Ran the producer's own and the predecessor job's focused suites unchanged, including the adversarial probe that failed the first gate (`review-adversarial-refute.test.ts`, unmodified — the old probe is not weakened; it still asserts the standalone cancel works and approval-after-cancel is refused).
3. Designed probes only after inspection, targeting each done-criterion, and ran them against the real queue API in the isolated fixture (not mocked callback returns).

## Results per criterion

**1. Production wiring. Verified.**
`scripts/tjob:287` → `POST /api/orchestrator/:id/cancel` (`orchestrator.routes.ts:207`, bearer-token authenticated) → `jobs.cancel` (`jobs.service.ts:997`) → `withdrawFromMergeQueue` → `mergeQueueRef.current.cancel(job)` (`orchestrator.module.ts:45-51`) — the real queue, not the standalone path. The four behaviors are distinguished and probed (probe 5, 6):

| Path | Behavior |
| --- | --- |
| queue wired, step queued/rebase/check | queue cancels: pid killed, `git rebase --abort` if rebasing, DB `state=cancelled, merge_step=none`, history entry `cancelled` with `by: 'tjob cancel'`, hub event `cancelled` |
| queue wired, refuses (`{cancelled:false}`) | `AppError` `JOB_MERGING` 409 with the queue's reason; job untouched (probed with a real refusal result) |
| queue wired, callback throws | the exception propagates out of `jobs.cancel` — never mistaken for success; job untouched, no cancellation evidence |
| callback undefined (standalone service, the 127a8543 fix) | before the push: local cancellation with the same history/hub records; at push/deploy/merged: `JOB_MERGING` "already pushing; it will merge" |

CLI text confirmed by reading `scripts/tjob`'s `api`/`render`: success prints the job line (`cancelled` state, no `ci:` suffix since `merge_step` is `none`, `steps:` list shows the `cancelled` entry); refusal prints `tjob: <reason>` to stderr and exits nonzero via the render's error path. Probe 1 additionally verifies the module-wiring shape end to end (queued job withdrawn with the queue's `by`-line recorded, sibling proceeds to merge onto origin/main, cancelled commit provably not on main).

**2. Transition contract. Verified.**
Queued (probe 1), in-flight check with a real tracked child (probe 7), in-flight stopped rebase with a real conflict + tracked resolver child (probe 8): all withdraw safely — the worktree is left clean with the branch tip untouched and no rebase left in progress. Push, deploy and merged refuse with `JOB_MERGING` "already pushing; it will merge", no history entry appended, job left running its step (probes 2–4 for each step). Non-queue steps (e.g. after a first cancel) are refused by the queue as "not in the CI/CD queue" (probe 11). The original adversarial suite passes unchanged: duplicate `tjob done` rejected with the review state reset exactly once; approve refused after cancel; cancel refused after approve; a queued job still cancellable. Probe 11: late `approve` after a queued-stage cancel → "not waiting for review". `tjob retry` cannot resurrect a cancelled job — the route refuses anything not `blocked` (`orchestrator.routes.ts:225-227`). Sibling jobs and failed branches untouched: probe 1's sibling merges normally after the lane is freed; cancel writes only the cancelled job's row plus an append-only history entry.

**3. Real wired queue, in-flight stages, deterministic barriers. Verified.**
Probe 7 (check): the check command is a fixture child that writes its pid and blocks; `jobs.cancel` SIGTERMs the tracked process group (the `onSpawn` pid recorded by `runTracked`), the child is gone — `process.kill(pid, 0)` throws (reaped, not a zombie) and `ps` shows no orphan — the check's outbox effect is finished `error: 'cancelled'`, no `push` history entry, and two further ticks leave `origin/main` untouched and the job `cancelled/none` (no resurrection via `listInMergeQueue`). Probe 8 (rebase): a genuinely conflicting rebase stops mid-way, the fixture resolver blocks, cancel kills it, runs `git rebase --abort`, and the worktree ends clean at the branch tip. Probes 9–10 are the deterministic completion-after-cancellation barriers: a held check "passes" *after* the cancel, and a held rebase "succeeds" *after* the cancel — in both cases the `runTokens` staleness check returns the step before any `setStep`, the last history entry stays `cancelled`, and origin never moves. This is the barrier that proves a cancelled step cannot later run push or deploy. In-flight rebase/check cancellation in this design suppresses future stages *and* stops the owned child by pid; what remains afterwards is bookkeeping (outbox effect finished `cancelled`, history entry), not an orphaned writer — probed, not inferred.

**4. Cancellation/cleanup races. Verified.**
Duplicate cancel (probe 11): the second pass finds no queue step, performs the plain idempotent update, and appends no second `cancelled` history entry or hub event (exactly one of each). Cancel followed by step completion: probes 9–10. Shutdown while cancelled (probe 11): the restart's `replayPush` handler skips a job whose `merge_step` is `none` — nothing is pushed and the row is unchanged. Disposal failure (probe 12): a dirty worktree at cancel time is kept whole ("dirty or inaccessible worktree; kept"), the job stays `cancelled/none` and unapprovable — a failed or skipped disposal never resurrects or approves; once the dirt is gone, the next sweep cleans the worktree while keeping the branch, still `cancelled`. Existing focused suites all pass (below).

**5. Safety. Held.** All probes are local, synthetic, temporary and cleaned (the fixture kills its own pids even on failure). The only inter-process kills are of fixture-recorded pids. Total review wall time including two probe-suite iterations and the combined run: well under the 30-minute bound; the probe suite alone runs in ~13 s.

## Counts and commands

| Suite | Tests | Result |
| --- | --- | --- |
| `orchestrator.test.ts` (includes the feature's five cancel tests) | 79 | pass |
| `review-adversarial-refute.test.ts` (first-gate probe, unmodified) | 15 | pass |
| `tjob.cli.test.ts` | 16 | pass |
| `cleanup.test.ts` | 3 | pass |
| `queued-cancel-refute-dfa274f4.test.ts` (this job) | 13 | pass |
| **Combined single run (all five files)** | **126** | **0 failures** (~88 s) |

- `npx tsx --tsconfig server/tsconfig.json --test …` for the four existing suites alone: 113/113.
- `npx tsc --noEmit -p server/tsconfig.json` — clean. `npx oxlint` on the probe file — 0 warnings, 0 errors.
- Per-criterion focused runs are what this review required; the workspace-wide gate was already run twice by the producer and is not re-run here.

## Observations (bounded or unreachable; none blocking)

1. **Microtask-only gap in the `queued` advance case** (`merge-queue.service.ts:505-514`): `setStep(job, 'rebase')` after `await landsOnItsBase(job)` is not token-guarded, so a cancellation landing exactly inside that suspension would leave `merge_step='rebase'` on a `state='cancelled'` row — and `listInMergeQueue` filters on `merge_step`, not `state`, so the next tick would advance the cancelled job. This is not reachable from production cancel traffic: `landsOnItsBase` contains no real awaits in its deciding paths, so the suspension is a single microtask, and every cancel ingress (`tjob` HTTP route, session tool) arrives as a macrotask, which cannot interleave inside a microtask gap on Node's loop. Documented as a latent sharp edge, not a reproduced defect; a defensive `stale()` check there would close it.
2. **Cancel's own `git rebase --abort` swallows failure** (`merge-queue.service.ts:571-573`). If the abort failed (e.g. a lock race with the just-signalled process), the job would still be `cancelled/none` with the worktree left mid-rebase. The design already keeps dirty worktrees (probe 12), `tjob resume`'s `stepRebase` aborts a leftover rebase at entry (`merge-queue.service.ts:200`), and probe 8 shows the normal path leaves the worktree clean — so the worst case is a kept, later-cleanable worktree, not corruption or a late push. Probe 10 additionally covers the variant where the cancelled job's worktree was clean and the post-cancel sweep disposed of it whole.
3. **Direct `queue.cancel` with a stale row snapshot** would re-record a `cancelled` history entry and hub event. Unreachable in production: the route exposes cancel only through `jobs.cancel`, which refetches the row synchronously immediately before the withdrawal (no await between fetch and decision — the snapshot cannot go stale within one event-loop turn); `mergeQueue.retry` is the only direct route call and is `blocked`-gated.
4. **`landsOnItsBase`'s parent follow rewrites `base_branch`/`last_error` without a token check** — the same microtask-only reachability as (1) and cosmetic on a cancelled job (a DB field on a row nothing further reads for execution).

None of these allows a late push, a late deploy, an approval of a cancelled job, or a resurrection: the only writers that move a cancelled job forward would need to interleave inside a microtask gap that no macrotask cancel can enter, and the token barriers cover every real await in `stepRebase`/`stepCheck`/`resolveConflicts` (verified line-by-line and probed in 8–10).

## Comparison with the producer's claims

- The 127a8543 fix does exactly what it claims: an unwired service cancels a before-push job itself with the same records the queue would write (probe 5), and still refuses from the push on (probe 5, second half). The wired `{cancelled:false}` refusal keeps its distinct meaning (probe 6), and a wired exception surfaces (probe 6).
- 346febf2's headline behaviors reproduce as committed: pid-tracked kill of a running check (the feature's own test, plus this job's stronger child-liveness assertions), refusal from push/deploy (feature tests, plus the `merged` case and history-preservation assertions here), lane release for the sibling (probe 1), and the jobs-service withdrawal (feature test, plus hub-event/CLI-text/origin-state assertions here).
- The old adversarial probe (`review-adversarial-refute.test.ts:461`) is intact and passes: one-time review-field reset, duplicate done/cancel, both-way approve/cancel guards.

## Limitations

- The `deploy`-step refusal is probed with a job that reached `deploy` before any Forgejo interaction (no token file), matching production's shape; a deploy mid-CI-poll uses the same snapshot-refusal code path (`cancel`'s first guard), so no additional probe was needed.
- Probe 8's cancel runs `queue.cancel` directly (not via `jobs.cancel`) so the worktree survives for inspection; the wired path into `queue.cancel` is separately probed in 1, 5–7, 9, 11, 12, so the combination is covered across probes.
- The SIGKILL escalation after the 1 s SIGTERM grace was not separately observed (the fixture children die on SIGTERM immediately, as production's children would); the escalation's code path is `unref`'d and cannot hang the server.
