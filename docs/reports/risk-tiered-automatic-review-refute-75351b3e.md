# Risk-tiered automatic review — refutation — 2026-11-10

Refutation of candidate `63d8ccba` at `75351b3e` (base `7fb08982`), merged `--no-ff` into current main `c9107779` (which includes per-model guidance `56a4ddfd`); merge commit `43d41641`, clean merge, no manual resolutions. Scope: risk-tier selection, migrations, transcript/CLI/status claims, and the 19-file diff. Verdict: **PASS** — every claimed behaviour reproduced green; no defect found.

## What the candidate does

- `selectReviewTier(job, diff, config)` decides `gate | refute | deep` from the diff after a green gate (`review.service.ts:108`): any risky path segment, protected repo, `deepPaths` prefix, or a same-line `writeFile(Sync)` config-writer heuristic → `deep`; then docs-only / tests-only globs or `< tiers.gateMaxLines` → `gate`; else `refute`. Persisted as `review_tier`; gate sets `review_step='policy'` for the `gate` tier and `'refute'` otherwise (`review.service.ts:244-249`).
- `review_tier TEXT` column via idempotent `addColumnToTableIfNotExists` migration + fresh schema + `OrchestratorJobRow`/patchable columns (`migrations.ts:524`, `schema.ts:163`, `orchestrator-jobs.db.ts`); reset to `null` on new HEAD and on `tjob done` (`review.service.ts:226`, `jobs.service.ts:873`).
- `refuteTimeoutMin` (default 10, validated 0 < x ≤ 20) recomputes `refuteTimeoutMs`; the legacy `refuteTimeoutMs` override is still honoured and still capped at 20 minutes; `deepPaths` and `tiers` parsed with the same drop-hostile-values style (`orchestrator-config.service.ts`).
- `deep` tier gets the full `MAX_REFUTE_TIMEOUT_MS` (20 min) box and always lands at the hub after a pass (`review.service.ts:258-260`, `316-320`); a `refute`-tier timeout records `review_verdict='timeout'` and parks at the hub with the gate-green reason plus `git diff --stat` (`review.service.ts:300-304`).
- Transcript/CLI/status: `tjob show` prints `review_tier` (`scripts/tjob`), status JSON gains `tier` and `flow.reviewTiers` counts of merged jobs (`status.service.ts`), markdown gains `tier:<x>` and `tiers gate N refute N deep N`, and the status page renders a tier badge and the tier counts (`StatusView.tsx`); the eval harness forwards `review_tier` (`evals/harness/runner.ts:40`). Docs updated to match (`docs/orchestrator.md`).

## Contract probes

- **Gate-only still runs its gate** — tier selection happens only after the gate passes and the worktree is clean (`review.service.ts:229-243`); dirty worktrees and red gates take `fixOrEscalate` before any tier can skip refutation. Reproduced by `gate tier runs the gate and policy without a refutation` (0 refute calls, one approval) and the pre-existing red-gate/dirty probes.
- **Gate-only cannot approve risky/unknown/protected work** — risky paths and protected repos are `deep` (hub always, asserted `review_tier='deep'`); ambiguous/unsafe brief paths and binary diffs stay high-risk in `evaluateReviewRisk` at policy, so they park at the hub even when the tier is `gate`. Reproduced by the tier-selection test and the fail-closed policy test.
- **Correct cross-family refuter, ≤20m boxes** — both `refute` and `deep` go through the single `selectRefuteBackend` path (identity mappings ignored, cross-family fallback); `refute` uses the configured box (`refuteTimeoutMin`-derived, default 10 min, hard-capped ≤ 20 min), `deep` always `MAX_REFUTE_TIMEOUT_MS`. No configuration path can exceed 20 minutes.
- **Timeout/cancel/restart/late-result fencing intact** — timeout aborts and archives the reviewer session, releases `inFlight`, records `verdict='timeout'`, parks at the hub with the stat, and never retries or approves (updated adversarial probe); cancel persists state before interrupting so late results are superseded; restart resumes the persisted step/tier without a second run. All covered by the adversarial suite, unchanged and green.
- **Legacy/missing config fail-closed** — missing file/string `review` section falls back to the conservative defaults (10-min box, default risky paths, empty `deepPaths`, tier thresholds); hostile values dropped; `refuteTimeoutMs: 20m` legacy configs keep working; `refuteTimeoutMin` above 20 is rejected. Reproduced by the malformed-config probe.
- **Failures never auto-approve** — the only auto-approval path is `stepPolicy` with a non-`deep` tier and low risk, reachable only from a green gate (`gate` tier) or a strict-JSON `pass` verdict (`refute` tier); gate red, defects, malformed verdicts, dirty refutations, and timeouts all escalate. Reproduced by the full review/adversarial chains.
- **Merged integration with per-model guidance** — the merge delta vs the candidate is exactly the 7 guidance files (`git diff 75351b3e HEAD --stat`); `buildJobPrompt(..., modelGuidance, handoverNote)` and its two call sites are untouched by the candidate; the eval harness (which now carries both `modelGuidance` and `review_tier`) passes 5/5.

## Verification commands and counts

- `npx --no-install tsx --tsconfig server/tsconfig.json --test <review.service, refute.service, review-gate.service, hub-wake.service, tjob.cli, orchestrator-job-usage, orchestrator, effect-outbox, review-adversarial-refute, status, chat-abort, chat-live-transport>` → **177 passed, 0 failed** (the original 167-test chain plus the candidate's new tier tests and the focused status suite), ~1.8 min.
- `npx cross-env NODE_ENV=development npx vitest run src/modules/status/tests/StatusView.test.tsx` → **2 passed, 0 failed**.
- `npx vitest run -c evals/vitest.config.ts` (`npm run evals:harness`) → **5 passed, 0 failed**.
- `npm run typecheck` (client + server + evals + morph-pacer tsconfigs) → passed.
- `npx oxlint` on the touched server/database/evals files plus `StatusView.tsx` → **0 errors, 1 pre-existing warning** (`set-state-in-effect` in `StatusView.tsx:170`, unchanged from base `7fb08982`; the candidate's diff adds no effects or state).
- `path.matchesGlob` requires Node ≥ 22.5; runtime is v22.23.4 — supported.

Non-blocking notes (not defects, no action taken): the config-writer heuristic is same-line only, so a multi-line `writeFile(target, …)` with the `.config` path built on another line is not escalated to `deep` — the docs describe exactly this same-line heuristic, and the policy backstops (maxLines, binary, brief paths, risky segments) still apply; `writesConfigFile`'s third regex is implied by the second. Neither is a reproduced defect; recorded for the fix round if one is wanted.

No feature changes made; this run only merged, reviewed, probed and reported.
