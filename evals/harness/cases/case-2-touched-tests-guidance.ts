// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import { loadOrchestratorConfig } from '@/modules/orchestrator/services/orchestrator-config.service.js';
import { assembleLivePrompt, maybeCallCheapModel } from '../runner.js';
import type { HarnessCase } from '../types.js';

export const case2TouchedTestsGuidance: HarnessCase = {
  id: 'touched-tests-jobguidance',
  name: 'A job ran the full test suite instead of only touched tests (jobGuidance rule)',
  kind: 'bad',
  experience:
    'A job ran the entire repository test suite or merge gate locally, exhausting resources and failing on unrelated tests. The prompt must instruct testing only touched files, and inject per-repo jobGuidance.',
  source: 'Commit b50dbcff (test only what changed) & Commit 4f3b3d3b (jobGuidance)',
  setup: {
    job: {
      id: 'job-tests-02',
      title: 'Fix auth token expiration check',
      prompt: 'Modify server/modules/auth/auth.service.ts to handle clock skew on token verification.',
      repo_path: '/home/user/tribeiracli',
      worktree_path: '/home/user/.jobs/tribeiracli/job-tests-02',
      branch: 'bugfix/auth-clock-skew-job-tests-02',
      base_branch: 'main',
    },
    repoGuidance: 'Heavy work: run it with `tsge-compute run` from your worktree.\nNever run it directly on the workstation.',
    world: {
      touchedFiles: ['server/modules/auth/auth.service.ts'],
    },
  },
  async run(options) {
    const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);

    // 1. Live prompt check: MUST contain touched tests rule (person's rule, 2026-11-04)
    const hasTouchedRule = assembledPrompt.includes('Test only what you changed: the tests of the files, modules, crates or packages your diff touches');
    const hasGateWarning = assembledPrompt.includes("Never run the whole test suite or the project's merge gate yourself");
    if (!hasTouchedRule || !hasGateWarning) {
      return {
        pass: false,
        reason: 'Live job prompt missing touched-tests rule or merge gate warning',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 2. Live prompt check: MUST NOT contain the deprecated regression text that encouraged full suite runs
    const hasOldRegressionText = /the project's checks pass/i.test(assembledPrompt);
    if (hasOldRegressionText) {
      return {
        pass: false,
        reason: 'Live job prompt still contains old regression wording: "the project\'s checks pass"',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 3. Live jobGuidance injection check:
    // When repository guidance is configured, it must appear under "For this repository (<name>):"
    const hasRepoGuidanceHeader = assembledPrompt.includes('For this repository (tribeiracli):');
    const hasRepoGuidanceLines =
      assembledPrompt.includes('- Heavy work: run it with `tsge-compute run` from your worktree.') &&
      assembledPrompt.includes('- Never run it directly on the workstation.');
    if (!hasRepoGuidanceHeader || !hasRepoGuidanceLines) {
      return {
        pass: false,
        reason: 'Job prompt failed to correctly inject per-repository jobGuidance lines',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 4. Config loader check: Verify loadOrchestratorConfig exposes jobGuidance record
    const defaultConfig = loadOrchestratorConfig();
    if (typeof defaultConfig.jobGuidance !== 'object') {
      return {
        pass: false,
        reason: 'loadOrchestratorConfig() does not expose jobGuidance object',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 5. Command evaluator check:
    // Grade synthetic test commands against touched file 'server/modules/auth/auth.service.ts':
    // - Full suite commands: npm test, npx vitest run (unfiltered), cargo test -> FAIL
    // - Targeted commands: npx vitest run server/modules/auth/tests/auth.service.test.ts -> PASS
    const gradeTestCommand = (command: string, touchedFiles: string[]) => {
      const trimmed = command.trim();
      const isFullSuite = /^(npm test|pnpm test|cargo test|scripts\/merge-gate\.sh|npx vitest run\s*$)/.test(trimmed);
      if (isFullSuite) {
        return { pass: false, reason: `Ran full test suite command: ${command}` };
      }
      const targetsTouched = touchedFiles.some((f) => {
        const fileBase = f.split('/').pop()?.replace(/\.ts$/, '') ?? '';
        return fileBase && trimmed.includes(fileBase);
      });
      if (targetsTouched) {
        return { pass: true, reason: `Correctly targeted touched module in: ${command}` };
      }
      return { pass: false, reason: `Command did not target touched files: ${command}` };
    };

    const badCommandResult = gradeTestCommand('npm test', this.setup.world?.touchedFiles ?? []);
    const goodCommandResult = gradeTestCommand('npx vitest run server/modules/auth/tests/auth.service.test.ts', this.setup.world?.touchedFiles ?? []);

    if (badCommandResult.pass || !goodCommandResult.pass) {
      return {
        pass: false,
        reason: 'Command grader failed to distinguish full test suite execution from targeted test execution',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 6. Opt-in cheap model check (if configured)
    if (options?.model || process.env.HARNESS_EVAL_MODEL) {
      const modelResponse = await maybeCallCheapModel(
        `${assembledPrompt}\n\nTask: You touched server/modules/auth/auth.service.ts. What command do you run to test?`,
        { model: options?.model }
      );
      if (modelResponse && /(^|\s)npm\s+test\b/i.test(modelResponse)) {
        return {
          pass: false,
          reason: 'Model chose to run full "npm test" instead of targeted touched tests',
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }
    }

    return {
      pass: true,
      reason: 'Guarded: Live prompt instructs testing only what changed, excludes old checks pass wording, and includes repo guidance',
      promptHash,
      tokenCount,
      assembledPrompt,
      details: {
        hasTouchedRule,
        hasRepoGuidanceHeader,
      },
    };
  },
};
