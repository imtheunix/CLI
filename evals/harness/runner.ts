// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { buildJobPrompt } from '@/modules/orchestrator/index.js';
import { calculatePromptHash, estimateTokenCount } from './summary.js';
import type { HarnessCaseSetup } from './types.js';

export type AssembledCasePrompt = {
  text: string;
  hash: string;
  tokens: number;
};

/**
 * Replays live prompt assembly using our codebase's live `buildJobPrompt`.
 * Never copies prompt templates.
 */
export function assembleLivePrompt(setup: HarnessCaseSetup): AssembledCasePrompt {
  const defaultJob: OrchestratorJobRow = {
    id: setup.job.id ?? 'test-job-01',
    title: setup.job.title ?? 'Harness Eval Task',
    prompt: setup.job.prompt ?? 'Complete the requested task.',
    repo_path: setup.job.repo_path ?? '/home/user/repo',
    worktree_path: setup.job.worktree_path ?? '/home/user/worktrees/repo/test-job-01',
    branch: setup.job.branch ?? 'feature/test-job-01',
    base_branch: setup.job.base_branch ?? 'main',
    requested_backend: setup.job.requested_backend ?? null,
    backend: setup.job.backend ?? 'claude',
    model: setup.job.model ?? 'claude-opus-5-5',
    state: setup.job.state ?? 'active',
    session_id: setup.job.session_id ?? 'sess-test-01',
    in_turn: setup.job.in_turn ?? 1,
    merge_step: setup.job.merge_step ?? 'queued',
    merge_attempts: setup.job.merge_attempts ?? 0,
    deploy_waiting_since: setup.job.deploy_waiting_since ?? null,
    merge_step_history: setup.job.merge_step_history ?? '[]',
    pushed_sha: setup.job.pushed_sha ?? null,
    last_error: setup.job.last_error ?? null,
    created_at: setup.job.created_at ?? new Date().toISOString(),
    updated_at: setup.job.updated_at ?? new Date().toISOString(),
  };

  const text = buildJobPrompt(
    defaultJob,
    setup.label ?? 'Claude · claude-opus-5-5',
    setup.projectMapGuidance ?? '',
    setup.continuation ?? false,
    setup.repoGuidance ?? '',
  );

  const hash = calculatePromptHash(text);
  const tokens = estimateTokenCount(text);

  return { text, hash, tokens };
}

/**
 * Opt-in cheap model runner: if an eval model is specified in environment
 * (e.g., HARNESS_EVAL_MODEL or EVAL_MODEL), calls the model API.
 * Defaults to null (no model call by default: deterministic check only).
 */
export async function maybeCallCheapModel(
  prompt: string,
  options?: { model?: string; systemPrompt?: string }
): Promise<string | null> {
  const model = options?.model ?? process.env.HARNESS_EVAL_MODEL ?? process.env.EVAL_MODEL;
  if (!model) {
    return null;
  }

  // Support OpenAI / OpenCode compatible endpoints if configured
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(`[evals/harness] Model ${model} requested but no API key found in env. Falling back to deterministic check.`);
    return null;
  }

  // Example generic fetch for opt-in cheap model invocation
  try {
    const url = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: 0,
      }),
    });
    if (!response.ok) {
      console.warn(`[evals/harness] Cheap model request failed (${response.status}): ${await response.text()}`);
      return null;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn('[evals/harness] Cheap model execution error:', err);
    return null;
  }
}
