// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import { TOOLS_REQUIRING_INTERACTION } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { TOOL_CONFIGS } from '../../../src/modules/chat/tools/configs/toolConfigs.js';
import { assembleLivePrompt, maybeCallCheapModel } from '../runner.js';
import type { HarnessCase } from '../types.js';

export const case1AutopilotQuestion: HarnessCase = {
  id: 'autopilot-blocking-question',
  name: 'A job asked a blocking question in autopilot',
  kind: 'bad',
  experience:
    'In unattended/autopilot mode, an agent invoked the interactive AskUserQuestion tool. The run hung waiting for user input that could not be delivered interactively.',
  source: 'docs/orchestrator.md & claude-runtime.provider.ts TOOLS_REQUIRING_INTERACTION',
  setup: {
    job: {
      id: 'job-autopilot-01',
      title: 'Database schema migration',
      prompt: 'Refactor users table to support multi-tenancy. You need to decide whether to add organization_id or use tenant_id.',
      repo_path: '/home/user/backend',
      worktree_path: '/home/user/.jobs/backend/job-autopilot-01',
      branch: 'feature/users-tenant-id-job-autopilot-01',
      base_branch: 'main',
    },
    permissionMode: 'bypassPermissions',
    priorTurns: [
      {
        role: 'user',
        content: 'Refactor users table to support multi-tenancy. Choose tenant_id vs organization_id.',
      },
    ],
  },
  async run(options) {
    const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);

    // 1. Live guidance verification:
    // The live orchestrator job prompt MUST instruct the agent to ask in text and end turn rather than blocking.
    const ruleInPrompt = assembledPrompt.includes(
      'If you need a decision from the person, ask it and end your turn: they answer in this session'
    );
    if (!ruleInPrompt) {
      return {
        pass: false,
        reason: 'Live job prompt missing instruction: "If you need a decision from the person, ask it and end your turn"',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 2. Live tool schema / classification check:
    // AskUserQuestion MUST be identified as an interactive tool requiring interaction in the provider runtime.
    if (!TOOLS_REQUIRING_INTERACTION.has('AskUserQuestion')) {
      return {
        pass: false,
        reason: 'TOOLS_REQUIRING_INTERACTION in provider runtime is missing AskUserQuestion',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 3. Live UI tool config check:
    // AskUserQuestion in TOOL_CONFIGS must specify question-answer content type so it is rendered appropriately.
    const askConfig = TOOL_CONFIGS['AskUserQuestion'];
    if (!askConfig || askConfig.input.contentType !== 'question-answer') {
      return {
        pass: false,
        reason: 'TOOL_CONFIGS[AskUserQuestion] is not properly mapped to question-answer contentType',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 4. Synthetic thread replay check:
    // Simulate two synthetic execution traces in autopilot:
    // - Bad trace: invokes AskUserQuestion tool directly.
    // - Good trace: outputs question text and completes turn without calling blocking modal tool.
    const badTrace = {
      toolCalls: [{ tool: 'AskUserQuestion', input: { questions: ['tenant_id or org_id?'] } }],
      finalText: '',
    };
    const goodTrace = {
      toolCalls: [],
      finalText: 'I need a decision: should we use tenant_id or organization_id? Please reply.',
    };

    const gradeTrace = (trace: typeof badTrace) => {
      const callsInteractiveQuestion = trace.toolCalls.some((c) => TOOLS_REQUIRING_INTERACTION.has(c.tool));
      if (callsInteractiveQuestion) {
        return { pass: false, reason: 'Called interactive tool AskUserQuestion in unattended autopilot mode' };
      }
      return { pass: true, reason: 'Completed turn cleanly without blocking modal question' };
    };

    const badGraded = gradeTrace(badTrace);
    const goodGraded = gradeTrace(goodTrace);

    if (badGraded.pass || !goodGraded.pass) {
      return {
        pass: false,
        reason: 'Synthetic trace grader failed to flag blocking AskUserQuestion in autopilot mode',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // 5. Opt-in cheap model check (if configured)
    if (options?.model || process.env.HARNESS_EVAL_MODEL) {
      const modelResponse = await maybeCallCheapModel(
        `${assembledPrompt}\n\nTask: An ambiguous choice between column names was encountered. What do you do?`,
        { model: options?.model }
      );
      if (modelResponse && /AskUserQuestion/i.test(modelResponse)) {
        return {
          pass: false,
          reason: 'Model output attempted to call AskUserQuestion rather than ending turn with text question',
          promptHash,
          tokenCount,
          assembledPrompt,
        };
      }
    }

    return {
      pass: true,
      reason: 'Guarded: Prompt directs ask-and-end-turn, AskUserQuestion is classified as requiring interaction',
      promptHash,
      tokenCount,
      assembledPrompt,
      details: {
        toolsRequiringInteraction: Array.from(TOOLS_REQUIRING_INTERACTION),
      },
    };
  },
};
