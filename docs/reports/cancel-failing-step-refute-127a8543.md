# Cancel then rejected in-flight rebase/check — 2026-11-10

Job `950402aa`. Source HEAD `127a854381b9074b5557a0af1f0bcd722d0dffb5`, containing
`346febf2a432e1e1994becbf38cb4d6261e0e7c5` (`tjob cancel` withdraws a job from the merge queue before the push).

## Question

Can an in-flight rebase or check operation that **rejects** after a real `tjob cancel` and the real
automatic cleanup of the job's owned worktree resurrect the cancelled job, notify its model, or later
push/deploy?

## Probe

One parameterized focused test beside the existing cancellation tests:

- `tjob cancel then a rejected in-flight rebase cannot resurrect the job`
- `tjob cancel then a rejected in-flight check cannot resurrect the job`

Each test uses the existing `withWorkspace`/`finishedJob` fixtures. `createMergeQueueService` is given an
injected `deps.run` that returns a controlled deferred promise for the target operation (`git rebase
origin/main` for rebase, `nice` for check) and passes every other command through to the real
`runCommand`. The deferred operation returns a promise and never calls `options.onSpawn`; by
construction it has no child process, so there is no OS child to prove cleaned up. After cancellation,
any command that unexpectedly reports a spawned pid is recorded through `onSpawn`, killed, and fails
the test.

Cancellation goes through a `JobsService` created with
`withdrawFromMergeQueue: (job) => queue.cancel(job)`, matching `orchestrator.module.ts`. `jobs.cancel`
therefore performs the queue withdrawal and then its own `jobs.tick()` automatic cleanup. The test
asserts the owned worktree is gone **before** rejecting the deferred operation, then awaits the queue
tick under an explicit 5 s deadline. It then runs one more `queue.tick()` under the same deadline, so a
later tick cannot advance the cancelled job to push or deploy.

Assertions after the rejection and the later tick:

- `state === 'cancelled'`, `merge_step === 'none'`;
- no new runtime turn (`runtime.turns.length` unchanged), so no model notification;
- `pushed_sha === null` and `origin/main` unchanged;
- no command after cancellation spawned a child;
- `last_error` is the injected rejection message, i.e. the tick catch recorded bookkeeping only;
- the `cancelled` merge-step history entry by `tjob cancel` is present.

## Commands and outcomes

New tests only:

```
npx --no-install tsx --tsconfig server/tsconfig.json --test \
  --test-name-pattern "rejected in-flight" \
  server/modules/orchestrator/tests/orchestrator.test.ts
```

Result: **2 run, 2 passed, 0 failed, 0 skipped**.

New tests plus existing pre-push cancellation/withdrawal and push/deploy guard tests:

```
npx --no-install tsx --tsconfig server/tsconfig.json --test \
  --test-name-pattern "tjob cancel|push" \
  server/modules/orchestrator/tests/orchestrator.test.ts
```

Result: **18 run, 18 passed, 0 failed, 0 skipped**. This includes the two new tests, the existing
`tjob cancel during the check`, `tjob cancel during the rebase`, `tjob cancel at push`, `tjob cancel at
deploy`, `tjob cancel through the jobs service withdraws a job from the queue`, and the push/deploy
guard tests (`main moving during the queue...`, `a restart between the push and recording it...`, `a push
that exits 0 but leaves the commit off origin/<base>...`, and the newer-push run tests).

Targeted lint: `npx --no-install oxlint server/modules/orchestrator/tests/orchestrator.test.ts` — **passed**.

No whole suite, build, or gate was run.

## Result

**No defect reproduced in this reject path.** After real cancellation and real worktree removal, a
rejected in-flight rebase or check does not resurrect the job, start a turn, notify the model, push, or
advance origin. The rejection reaches the queue tick catch at
`server/modules/orchestrator/services/merge-queue.service.ts:531-536`, which writes `last_error` only.
`stepRebase` and `stepCheck` rethrow the injected rejection before any `setStep`; `stepCheck` also
finishes its outbox row as failed before rethrowing. The cancelled row therefore stays
`cancelled`/`none`, and the recorded `last_error` is harmless bookkeeping.

Relevant source:

- `merge-queue.service.ts:531-536` — tick catch records `last_error` and logs, nothing else.
- `merge-queue.service.ts:197-236` — `stepRebase` stale-token checks and rethrow path.
- `merge-queue.service.ts:243-305` — `stepCheck` catch finishes the outbox row and rethrows.
- `merge-queue.service.ts:553-578` — `cancel` bumps the token, stops the step, sets `cancelled`/`none`.
- `jobs.service.ts:997-1033` — `cancel` withdraws through the queue, aborts the session, then ticks.
- `jobs.service.ts:1210-1211` — `tick` starts with the automatic `sweepCleanup`.
- `jobs.service.ts:1055-1085` — automatic `sweepCleanup` removes the cancelled job's worktree.
- `cleanup.service.ts:72-134` — `cleanupJob` removes the owned worktree and prunes checkpoints.

## Cleanup

`withWorkspace`'s `finally` unsubscribes the run-completion listener, clears the chat run registry,
awaits pending checkpoints, closes the database connection, restores `DATABASE_PATH`, and removes the
temporary workspace root. The deferred operations spawn no child by construction, so there is no fixture
child to reap; any unexpected post-cancellation spawn is killed and fails the test.

## Limitations

- The injection deliberately covers a rejected filesystem/git operation. Normal `runCommand` converts
  process failures into `CommandResult`; this probe does not exercise that conversion.
- Because the blocked operations are deferred promises, they spawn no child; the probe does not cover a
  real child process that outlives cancellation.
- Only the rebase/check reject path is covered, not other races (e.g. a rejection after a push has
  started, or a restart during the rejection).
- No minimal fix is recommended because no defect was reproduced.
