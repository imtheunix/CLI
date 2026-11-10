# Per-model job guidance — refutation — 2026-11-10

Refutation of candidate `2d02fc6e` at `56a4ddfd` (base `7fb08982`). Scope: per-model job guidance/config only. Verdict: **PASS** — every claimed behaviour reproduced, no defect found.

## What the candidate does

- `OrchestratorConfig.modelGuidance: Record<string, string>` (required, defaults `{}`), parsed like `jobGuidance`: object entries kept only when string and non-blank, stored trimmed (`orchestrator-config.service.ts`).
- `buildJobPrompt` gains a `modelGuidance = ''` parameter between `repoGuidance` and `handoverNote`; non-empty guidance renders a `For this model (<job.model>):` bullet block after the repository guidance (`jobs.service.ts:203`).
- The single production call site reads `deps.config().modelGuidance[ready.model]` with a null guard on `ready.model` and passes it before `handoverNote` (`jobs.service.ts:690-691`).
- The eval harness replays the live assembler: `modelGuidance?: string` on `HarnessCaseSetup`, passed as the sixth arg in `assembleLivePrompt` (`runner.ts:58`).

## Checks reproduced

- **Exact model keys append guidance after repo guidance**: `orchestrator.test.ts` test 10 — the `claude` job's turn contains both blocks with `For this repository (demo):` before `For this model (claude-opus-5-5):`. Reproduced.
- **Other models receive none**: same test — the `codex` job's turn has no `For this model` and no guidance line, while repo guidance still applies. Reproduced.
- **Blank/non-text entries ignored**: test 11 — missing file → `{}`; `'  x  '` trimmed to `x`; `'   '` and `3` dropped; mirrors the `jobGuidance` loader exactly. Reproduced.
- **Handover/continuation arguments not shifted**: only two `buildJobPrompt` call sites exist (`jobs.service.ts:691`, `evals/harness/runner.ts:52`), both updated; `handoverNote` stays the last argument. Handover tests 73/74 (probe-once, saved-prompt resume) pass, and a probe confirmed guidance never lands in the handover slot and continuation text is intact. Reproduced.
- **Eval harness passes the new field**: `assembleLivePrompt` forwards `setup.modelGuidance ?? ''`; a probe (temporary vitest file, deleted after) asserted the block lands after repo guidance and is absent by default; the 5 existing harness cases keep their hashes. Reproduced.
- **Source review**: only the one full `OrchestratorConfig` literal fixture needed the new required field (`orchestrator-job-usage.test.ts:98`); other tests mutate a loaded config. `OrchestratorJobRow.model` is `string | null` and guarded at the call site.

## Verification commands and counts

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/orchestrator.test.ts` → **74 passed, 0 failed** (includes the 2 new model-guidance tests and the handover/continuation suites).
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/orchestrator-job-usage.test.ts` → **1 passed, 0 failed**.
- `npx vitest run -c evals/vitest.config.ts` (`npm run evals:harness`) → **5 passed, 0 failed**; prompt hashes unchanged for cases without `modelGuidance`.
- `npx tsc --noEmit -p server/tsconfig.json` → passed. `npx tsc --noEmit -p evals/tsconfig.json` → passed.
- `npx oxlint` on the 6 touched files → **0 warnings, 0 errors**; `npm run lint:server` → 0 errors (26 pre-existing repo-wide warnings).

No feature changes made; this run only merged, reviewed, probed and reported.
