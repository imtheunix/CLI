# Offline certification of the preserved orchestrator recovery branch

Job 20b54eb8 (continuation of stalled job 2e7d6a2e). Certifies, without activation, that the
recovery work preserved as `b8930b7f` still applies to fresh `origin/main` and still passes its
own orchestrator suite.

## Inputs

- Fresh main: `cac72b115ea54cea3b7cc4a1c4727db9d56e2418` (`origin/main`, also the pushed head of
  `feature/cli-orchestrator-certify-preserved-recov-2e7d6a2e`).
- Preserved recovery branch: `b8930b7f` (`bugfix/cli-orchestrator-recover-orphaned-jobs-d-970a498b`).
  It is a direct descendant of `cac72b11`: no rebase or conflict correction was required.
- Recovery commits, in order: `72f6bb27`, `6ffee29c`, `5ae5b126`, `b8930b7f`.
- Baseline evidence and condition-by-condition review: `docs/reports/orchestrator-activation-970a498b.md`.

## Method

The certification worktree was moved to `b8930b7f` only for the run, with the production
environment selected (`NODE_ENV=production`) so the recovery guards exercised are the production
ones. No live daemon was contacted, no orchestrator config was edited, and nothing was restarted.

Exact suite (the 278-test orchestrator suite listed in the baseline report):

```sh
NODE_ENV=production npx tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/*.test.ts
```

## Results

- Orchestrator suite: **278 pass, 0 fail, 0 cancelled, 0 skipped** (duration ~87.9 s).
- `npm run typecheck`: clean across `tsconfig.json`, `server/tsconfig.json`, `evals/tsconfig.json`,
  `morph-pacer/tsconfig.json`.
- `npm run lint -- --quiet`: clean.

## Behaviors certified

The suite covers the four contract areas named in the brief, unchanged from the baseline review:

1. **Recovery** — stale `in_turn` rows are resumed once per interrupted turn, never overlapping a
   live run, armed limit recovery or a hub wait (`jobs.service.ts::recover`).
2. **Disk** — low disk refuses new work (`INSUFFICIENT_DISK` at create) and pauses merge checks
   without waking the agent (`merge-queue.service.ts::stepCheck`).
3. **Idle** — an observably idle run is continued once per ended turn with retry after a refused
   nudge (`health.service.ts::continueIdle`).
4. **Shared model** — a model offered by the requested backend is accepted, and Morph stays on the
   Morph backend (`resolveRequestedModel`, `MODEL_BACKEND_MISMATCH` only on a real mismatch).

## Scope

No activation: no daemon restart, no config/agent-file edits, and no full project gate was run. The
diff of this branch is only this report; the recovery code itself remains preserved on
`bugfix/cli-orchestrator-recover-orphaned-jobs-d-970a498b` at `b8930b7f`.
