# Bounded offline review of the READY orchestrator activation branch

Job 970a498b. Branch `bugfix/cli-orchestrator-recover-orphaned-jobs-d-970a498b` from `cac72b11` (origin/main).

## Cherry-picks incorporated (in order)

- `30be8acd` fix(orchestrator): refuse low-disk work and resume idle sessions
- `b01ff75e` test(orchestrator): remove redundant continuation service
- `48fa8a9a` fix(orchestrator): accept a model offered by the requested backend

## Verification

`NODE_ENV=production npx tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/*.test.ts`:
- Before fix: 277 pass / 1 fail (`low disk pauses merge checks in check without a command or an agent turn`).
- After fix: 278 pass / 0 fail. Duration ~74 s.

`npm run typecheck`: clean.
`npm run lint -- --quiet`: clean.

## Defect found and fixed

The cherry-picked test `low disk pauses merge checks in check without a command or an agent turn`
(orchestrator.test.ts:374) asserted `ctx.runtime.turns.length === 0` after driving the merge queue.
But the test setup `finishedJob(ctx, ...)` already ran `jobs.create`, which enqueues one agent turn on
the runtime fixture. `runtime.turns` is append-only — `runtime.finish` only resolves the writer, it
does not remove the turn entry — so `turns.length` is 1 even when the paused check correctly sent no
new turn. The intent ("the agent is never woken *again* for a paused check") is preserved by capturing
the pre-drain count and comparing deltas. One-line fix; no production code touched.

## Brief's conditions confirmed

1. **Once-per-ended-turn continuation with failed retry.** `health.service.ts::continueIdle` gates on
   `lastIdleTurnKey` keyed by `job.updated_at` (each ended turn bumps it). On a `refused`/`!started` nudge
   or a thrown error it deletes the key so the next tick retries. Busy sessions (`chatRunRegistry.isProcessing`)
   and armed recovery (`isWaitingForHub || job.resume_at`) are both skipped at line 267-269.
2. **Stale `in_turn` recover does not overlap busy runs nor armed recovery/waitsForHub.**
   `jobs.service.ts::recover` (1264-1280) iterates `state='active'` rows with `in_turn=1` AND no live
   `chatRunRegistry` entry; `armLimitRecovery` and `holdForAuthRequired` both clear `in_turn: 0` when
   they arm a recovery or hold for the hub, so an active job with `limit_recovery` armed or in
   `waitsForHub` has `in_turn=0` and is filtered out at line 1269 — no separate `resume_at` check needed.
   Live `outbox.runningHere` resume rows are also excluded (1271). The once-per-interrupted-turn key
   `resume:restart:{id}:{anchor}` pins replay to the last `start_turn` row (the turn that was cut).
3. **Low disk only blocks new starts and merge-check starts.** `jobs.service.ts::create` (after 30be8acd)
   throws `INSUFFICIENT_DISK` on `availableBytes(worktreesRoot) < requireFreeGiB`. The merge queue's
   `stepCheck` (merge-queue.service.ts:247-250) returns without setting step when
   `freeGiB <= checkFreeGiB`; step 'check' is re-tried on the next tick and the job is never sent
   back to its agent. No flyer/update paths are gated.
4. **Morph model resolver and shared-explicit-backend.** `resolveRequestedModel` (after 30be8acd) prefers
   the morph backend when the requested model is in morph's `models` map with /morph/i in its resolved
   name. `jobs.service.ts::create` (after 48fa8a9a) uses `resolveRequestedModel(config, null, model)` to
   detect models a different backend serves and surfaces `MODEL_BACKEND_MISMATCH` only when the explicit
   `backend` does not offer the requested id, otherwise resolves normally. Regression tests at
   orchestrator.test.ts:338 (`morph/morph-kimik31` stays on Morph) and 365
   (zcode's `GLM-5.3` accepted even when glm sorts first for the same id) both pass.
5. **No DeepSeek delegation bypass.** No `--tools-experimental-delegate` flag is added anywhere in the
   diff. Subagent routing (`morph-worker`/`morph-scout`) stays inside the normal Task pipeline; no
   separate subagent tjob slots are introduced.

## Live-daemon safety

No edits to `~/.config/cli/orchestrator.json`, `~/.config/opencode/agents/*`, user configs, or the live
daemon's worktrees; no daemon restart. Only the orchestrator test file is modified beyond the
cherry-picks.

## Files changed beyond the cherry-picks

- `server/modules/orchestrator/tests/orchestrator.test.ts`: capture pre-drain turn count; compare delta
  instead of absolute zero in the `low disk pauses merge checks ...` assertion.
