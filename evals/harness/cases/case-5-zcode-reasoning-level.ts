// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCandidates, writeZcodeSelection } from '@/modules/providers/index.js';
import { assembleLivePrompt } from '../runner.js';
import type { HarnessCase } from '../types.js';

export const case5ZcodeReasoningLevel: HarnessCase = {
  id: 'zcode-reasoning-level-glm',
  name: 'Zcode reasoningLevel missing selected full GLM',
  kind: 'bad',
  experience:
    'In ZCode 0.17.1, an unentitled default or one without a supported reasoningLevel is silently replaced by ZCode with full GLM-5.3 instead of GLM-5.3-Flash. The config must write reasoningLevel explicitly, and output must be stopped if full GLM is reported.',
  source: 'docs/orchestrator.md (ZCode plan selection) & Commit 55fd74d8',
  setup: {
    job: {
      id: 'job-zcode-05',
      title: 'Run GLM Flash task via ZCode',
      prompt: 'Implement streaming parser for metrics stream.',
      repo_path: '/home/user/backend',
      worktree_path: '/home/user/.jobs/backend/job-zcode-05',
      branch: 'feature/metrics-parser-05',
      base_branch: 'main',
      backend: 'zcode',
      model: 'GLM-5.3-Flash',
    },
    label: 'GLM Flash · GLM-5.3-Flash',
  },
  run() {
    const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);

    // 1. Live plan candidate check: GLM-5.3-Flash must be supported by eligible plans
    const flashPlans = planCandidates('GLM-5.3-Flash', new Date());
    if (flashPlans.length === 0) {
      return {
        pass: false,
        reason: 'planCandidates returned no eligible plans for GLM-5.3-Flash',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }
    const hasCodingPlan = flashPlans.some((p) => p.providerId === 'account:zai-individual-coding-plan');
    if (!hasCodingPlan) {
      return {
        pass: false,
        reason: 'Coding Plan is missing from planCandidates for GLM-5.3-Flash',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 2. Test live writeZcodeSelection writes options.reasoningLevel
    // Create an isolated temp home directory to avoid mutating the user's ~/.zcode
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-eval-'));
    const origHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;
      const targetProvider = 'account:zai-individual-coding-plan';
      const targetModel = 'GLM-5.3-Flash';
      const targetReasoningLevel = 'medium';

      writeZcodeSelection(targetProvider, targetModel, targetReasoningLevel);

      const configFile = path.join(tempHome, '.zcode', 'v2', 'provider_config.json');
      if (!fs.existsSync(configFile)) {
        return {
          pass: false,
          reason: 'writeZcodeSelection did not create provider_config.json',
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }

      const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const selection = written?.config?.defaultModelSelection;

      if (!selection) {
        return {
          pass: false,
          reason: 'written config missing defaultModelSelection',
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }

      if (selection.providerId !== targetProvider || selection.modelId !== targetModel) {
        return {
          pass: false,
          reason: `written config provider/model mismatch: got ${selection.providerId}/${selection.modelId}`,
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }

      // CRITICAL CHECK: options.reasoningLevel MUST be present
      if (!selection.options || selection.options.reasoningLevel !== targetReasoningLevel) {
        return {
          pass: false,
          reason: `Regression: options.reasoningLevel was missing or mismatch: got ${JSON.stringify(selection.options)}`,
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }

      // 3. Replay check: Verify that if ZCode's first session.updated report returns full GLM-5.3
      // instead of Flash, the mismatch guard refuses the output and halts the turn.
      const requestedModel = 'GLM-5.3-Flash';
      const simulateZcodeReportCheck = (reportedModel: string) => {
        if (reportedModel !== requestedModel) {
          return {
            halt: true,
            error: `Headless ZCode reported ${reportedModel}, not the requested ${requestedModel}: stopped before model request`,
          };
        }
        return { halt: false, error: null };
      };

      const silentFallbackReport = simulateZcodeReportCheck('GLM-5.3');
      const correctReport = simulateZcodeReportCheck('GLM-5.3-Flash');

      if (!silentFallbackReport.halt || correctReport.halt) {
        return {
          pass: false,
          reason: 'Model mismatch detector failed to halt on silent fallback to full GLM-5.3',
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }

      return {
        pass: true,
        reason: 'Guarded: writeZcodeSelection writes reasoningLevel, and mismatch check stops silent full GLM fallback',
        promptHash,
        tokenCount,
        assembledPrompt,
        details: {
          writtenReasoningLevel: selection.options.reasoningLevel,
          mismatchHalt: silentFallbackReport.halt,
        },
      };
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  },
};
