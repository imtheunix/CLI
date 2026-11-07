<!-- Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed. -->
# Harness Regression Evals

Harness regression evals replay small synthetic job threads that each reproduce a **REAL past harness mistake** in CLI jobs and orchestration.

Unlike static unit tests that hardcode fixture strings, these evals test against **LIVE prompt and guidance text** and **LIVE tool/command schemas** imported directly from the codebase (never copies). When prompt wording, job guidance, or schemas change in the product, these evals immediately verify whether the changes preserve harness safety or reintroduce known failure modes.

By default, all cases run **deterministically** with zero model calls (evaluating assembled prompts, tool constraints, and state transitions). An opt-in mode using a cheap model is available when desired.

## Running the Evals

Run all harness evals using Vitest:

```bash
npx vitest run evals/harness
```

To run a specific case:

```bash
npx vitest run evals/harness -t "autopilot"
```

### Opt-in Cheap Model Mode

To evaluate model completions against a cheap model:

```bash
HARNESS_EVAL_MODEL=gemini-2.5-flash npx vitest run evals/harness
```

When `HARNESS_EVAL_MODEL` (or `EVAL_MODEL`) is unset, the harness executes purely deterministic assertions and makes zero network or model requests.

## Seed Cases

| Case | Kind | Experience / Past Mistake | Source & Live Invariant |
|---|---|---|---|
| `(1) a job asked a blocking question in autopilot` | `bad` | An unattended autopilot job invoked `AskUserQuestion`, blocking indefinitely waiting for interaction. | Prompt instructs ask-and-end-turn; `TOOLS_REQUIRING_INTERACTION` in Claude runtime classifies `AskUserQuestion`. |
| `(2) a job ran the full test suite instead of only touched tests (jobGuidance rule)` | `bad` | A job ran `npm test` or the full merge gate instead of only tests touched by its diff, failing on unrelated tests. | `buildJobPrompt` enforces touched tests only, excludes "checks pass" trigger, and injects per-repo `jobGuidance`. |
| `(3) hub resume while the CLI re-attached the same turn (duplicate instance)` | `bad` | Server restart or hub wake re-attached a turn while recovery triggered another, running duplicate instances on the session. | `chatRunRegistry.isProcessing(sessionId)` and `retireDetachedSessionTurns` guard against concurrent instances. |
| `(4) a branch based on a cancelled job's branch was marked merged` | `bad` | Job 88328da6 was marked merged into the branch of cancelled job f8a49612 and never reached main. | `landsOnItsBase` / merge queue state machine blocks any job stacked on a cancelled/failed parent. |
| `(5) Zcode reasoningLevel missing selected full GLM` | `bad` | ZCode 0.17.1 headless `-p` silently fell back to full GLM-5.3 when `reasoningLevel` was missing from provider config. | `writeZcodeSelection` ensures `options.reasoningLevel` is written; provider mismatch check halts if full GLM is reported. |

## Run Summary (Prompt Hash + Token Count)

Every run records the assembled prompt hash (first 12 characters of SHA-256) and estimated token count per case. The summary is printed upon test completion and can be inspected via `getRecordedSummaries()`:

```text
| Case ID | Name | Kind | Prompt Hash | Tokens | Status | Reason |
|---|---|---|---|---|---|---|
| `autopilot-blocking-question` | A job asked a blocking question in autopilot | bad | `e03504bb8427` | 512 | PASS | Guarded: Prompt directs ask-and-end-turn... |
...
```

## How to Add a Case

1. **Identify the historical harness mistake**:
   - Reference the issue, commit, or doc finding where an agent or orchestrator took the wrong path.
   - Clarify whether the case is:
     - `bad`: reproduces a mistake that must fail if unhandled.
     - `guard`: verifies a guard prevents a known bad transition.
     - `control`: verifies ordinary work proceeds without false alarms.

2. **Create the case file in `evals/harness/cases/case-<number>-<slug>.ts`**:
   - Import live prompt builders and schemas from `server/modules/orchestrator/index.js`, `server/modules/providers/index.js`, or tool configurations. Never copy prompt text.
   - Define the `HarnessCase` object with `id`, `name`, `kind`, `experience`, `source`, `setup`, and `run()`.

   ```typescript
   // Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
   import { assembleLivePrompt } from '../runner.js';
   import type { CaseResult, HarnessCase } from '../types.js';

   export const caseMyNewCase: HarnessCase = {
     id: 'my-new-case',
     name: 'Description of the case',
     kind: 'bad',
     experience: 'Describe the real past harness failure...',
     source: 'docs/orchestrator.md & commit hash',
     setup: {
       job: { id: 'job-id', title: 'Task title', prompt: 'Task prompt' },
     },
     async run(options) {
       const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);
       // Perform deterministic checks on assembledPrompt and live schemas
       return {
         pass: true,
         reason: 'Guarded against regression',
         promptHash,
         tokenCount,
         assembledPrompt,
       };
     },
   };
   ```

3. **Register the case**:
   - Export your case from `evals/harness/index.ts`.
   - Add a test entry in `evals/harness/harness.test.ts`.

4. **Verify**:
   - Run `npx vitest run evals/harness` to ensure the new case passes and its prompt hash and token count are recorded in the summary table.
