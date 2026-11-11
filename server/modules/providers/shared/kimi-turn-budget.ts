/**
 * Kimi K3.1's per-turn budgets, enforced at the provider turn control point.
 *
 * The person's decision (2026-11-11): a Kimi turn should produce at most ~800
 * output tokens and read at most ~5k uncached input tokens per call; a Kimi
 * task that does not fit 30 minutes is split. The delegation prose alone was
 * not honoured, so the runtime refuses an over-budget prompt instead of
 * truncating it, and caps the model's output through OpenCode's model limit.
 */

/** Per-turn Kimi output budget (output tokens, reasoning excluded). */
export const KIMI_TURN_OUTPUT_TOKENS = 800;

/** Per-call Kimi uncached input budget (new prompt tokens, cache reads excluded). */
export const KIMI_CALL_UNCACHED_INPUT_TOKENS = 5_000;

/** A Kimi task that does not fit this wall time is split into steps. */
export const KIMI_TASK_SPLIT_MS = 30 * 60_000;

export type KimiBudgetViolation = 'output' | 'uncachedInput';

export type KimiRole = 'hub' | 'planner' | 'jobs' | 'compaction';

/** A Kimi call's measured usage; null means the provider did not report it. */
export type KimiCallUsage = {
  role: KimiRole;
  sessionId?: string;
  label?: string;
  outputTokens?: number | null;
  uncachedInputTokens?: number | null;
};

/** One call that exceeded a budget, with the values that made it exceed. */
export type KimiBudgetWarning = {
  role: KimiRole;
  sessionId: string | null;
  label: string;
  outputTokens: number | null;
  uncachedInputTokens: number | null;
  violations: KimiBudgetViolation[];
};

/** Whether a model id belongs to the Kimi K3.1 group. */
export function isKimiModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.toLowerCase().includes('kimi');
}

/**
 * A conservative token estimate for a prompt. Four characters per token is the
 * usual English/code approximation; it is deliberately not a truncation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type KimiTurnInputCheck = {
  kimi: boolean;
  allowed: boolean;
  estimatedUncachedInputTokens: number;
  violations: KimiBudgetViolation[];
  reason: string | null;
};

/**
 * Checks a Kimi turn's new prompt before it is sent. The prompt is the only
 * uncached input this process controls; conversation history is cached by the
 * provider and is not counted here. An over-budget prompt is refused, never
 * shortened.
 */
export function checkKimiTurnInput(input: {
  model: string | null | undefined;
  prompt: string;
  attachmentsText?: string;
}): KimiTurnInputCheck {
  const kimi = isKimiModel(input.model);
  const estimated = estimateTokens(`${input.prompt}${input.attachmentsText ?? ''}`);
  if (!kimi) {
    return { kimi: false, allowed: true, estimatedUncachedInputTokens: estimated, violations: [], reason: null };
  }
  const violations: KimiBudgetViolation[] = estimated > KIMI_CALL_UNCACHED_INPUT_TOKENS ? ['uncachedInput'] : [];
  return {
    kimi: true,
    allowed: violations.length === 0,
    estimatedUncachedInputTokens: estimated,
    violations,
    reason: violations.length === 0
      ? null
      : `Kimi turn refused: the prompt is ~${estimated} uncached input tokens, over the ${KIMI_CALL_UNCACHED_INPUT_TOKENS}-token per-call budget. Split the task into smaller steps; the prompt was not truncated.`,
  };
}

/**
 * The OpenCode model config that caps a Kimi model's output. OpenCode reads
 * `limit.output` as the model's maximum output tokens, so this is the
 * mechanical output guard; it is passed per turn through
 * `OPENCODE_CONFIG_CONTENT`, never written to the user's global config.
 */
export function kimiOutputLimitConfig(model: string | null | undefined): Record<string, unknown> | null {
  if (!isKimiModel(model) || typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  return {
    provider: {
      [provider]: {
        models: {
          [modelId]: { limit: { output: KIMI_TURN_OUTPUT_TOKENS } },
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeRecords(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeRecords(current, value) : value;
  }
  return merged;
}

/**
 * Merges the Kimi output limit into an existing `OPENCODE_CONFIG_CONTENT`
 * value. A malformed existing value is left untouched rather than replaced, so
 * a user's config is never silently dropped.
 */
export function mergeKimiOutputLimitConfig(
  existing: string | undefined,
  model: string | null | undefined,
): string | undefined {
  const limit = kimiOutputLimitConfig(model);
  if (!limit) return existing;
  if (!existing || !existing.trim()) return JSON.stringify(limit);
  try {
    const parsed = JSON.parse(existing) as unknown;
    if (!isRecord(parsed)) return existing;
    return JSON.stringify(mergeRecords(parsed, limit));
  } catch {
    return existing;
  }
}

/**
 * Evaluates one measured Kimi call. Unavailable usage is not treated as zero:
 * a missing value is skipped, and a call with no reported usage is not flagged.
 */
export function evaluateKimiCallUsage(usage: KimiCallUsage): KimiBudgetWarning | null {
  const output = typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
  const uncachedInput = typeof usage.uncachedInputTokens === 'number' && Number.isFinite(usage.uncachedInputTokens)
    ? usage.uncachedInputTokens
    : null;
  const violations: KimiBudgetViolation[] = [];
  if (output !== null && output > KIMI_TURN_OUTPUT_TOKENS) violations.push('output');
  if (uncachedInput !== null && uncachedInput > KIMI_CALL_UNCACHED_INPUT_TOKENS) violations.push('uncachedInput');
  if (violations.length === 0) return null;
  return {
    role: usage.role,
    sessionId: usage.sessionId ?? null,
    label: usage.label ?? usage.sessionId ?? usage.role,
    outputTokens: output,
    uncachedInputTokens: uncachedInput,
    violations,
  };
}
