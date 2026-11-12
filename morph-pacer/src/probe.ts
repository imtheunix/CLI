import type { Clock } from './clock.js';
import { DEFAULT_GROUPS } from './config.js';
import type { Usage } from './pacer.js';
import { RollingWindow, type WindowTotals } from './windows.js';

/**
 * A bounded, direct Morph rate-limit probe.
 *
 * It deliberately does not go through the live pacer proxy: the point is to observe Morph's own
 * per-minute admission, not the proxy's. Because direct traffic bypasses the live ledger, the probe
 * keeps its own sliding-60s window and adds the live `/pacer/usage` window to it before every call.
 *
 * The probe never infers a ceiling from token estimates. A ceiling is only claimed from provider
 * usage plus a repeatable 429 at a combined occupancy that is at or above the configured cap.
 */

export interface ProbeModelConfig {
  model: string;
  group: string;
  inputBudget: number;
  outputBudget: number;
}

export const PROBE_MODELS: ProbeModelConfig[] = [
  {
    model: 'morph-dsv41flash',
    group: 'deepseek',
    inputBudget: DEFAULT_GROUPS.deepseek.caps.uncachedIn,
    outputBudget: DEFAULT_GROUPS.deepseek.caps.out,
  },
  {
    model: 'morph-kimik31',
    group: 'kimik31',
    inputBudget: DEFAULT_GROUPS.kimik31.caps.uncachedIn,
    outputBudget: DEFAULT_GROUPS.kimik31.caps.out,
  },
];

export interface LiveUsage {
  uncachedIn: number;
  out: number;
}

export interface ProbeRequest {
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface ProbeResponse {
  status: number;
  retryAfterMs: number | null;
  usage: Usage | null;
}

export interface ProbeTransport {
  postChat(request: ProbeRequest): Promise<ProbeResponse>;
  getLiveUsage(): Promise<LiveUsage>;
}

export interface ProbeRecord {
  call: number;
  model: string;
  step: { input: number; output: number };
  target: { inputTokens: number; outputTokens: number };
  status: number;
  latencyMs: number;
  retryAfterMs: number | null;
  usage: Usage | null;
  windows: {
    live: WindowTotals;
    probe: WindowTotals;
    combined: WindowTotals;
  };
}

export type ProbeJudgment =
  | 'ceiling'
  | 'cap-not-explanatory'
  | 'inconclusive'
  | 'no-ceiling-observed';

export interface ProbeCeiling {
  proven: boolean;
  repeatable: boolean;
  capExplanatory: boolean;
  belowThresholdSuccesses: number;
  threshold: WindowTotals | null;
}

export interface ProbeResult {
  model: string;
  group: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  calls: number;
  steps: { input: number; output: number };
  budgets: { input: number; output: number };
  caps: { uncachedIn: number; out: number };
  headroom: number;
  haltReason: string | null;
  judgment: ProbeJudgment;
  ceiling: ProbeCeiling;
  windows: {
    live: WindowTotals;
    probe: WindowTotals;
    combined: WindowTotals;
  };
  records: ProbeRecord[];
}

export interface ProbeOptions {
  model: ProbeModelConfig;
  transport: ProbeTransport;
  clock: Clock;
  caps: { uncachedIn: number; out: number };
  headroom?: number;
  deadlineMs?: number;
  maxCalls?: number;
  maxInputSteps?: number;
  maxOutputSteps?: number;
  startInputTokens?: number;
  startOutputTokens?: number;
  successesPerLevel?: number;
}

const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_MAX_CALLS = 160;
const DEFAULT_MAX_INPUT_STEPS = 60;
const DEFAULT_MAX_OUTPUT_STEPS = 30;
const DEFAULT_START_INPUT_TOKENS = 1_000;
const DEFAULT_START_OUTPUT_TOKENS = 64;
const DEFAULT_SUCCESSES_PER_LEVEL = 3;

export const PROBE_HARD_LIMITS = {
  deadlineMs: DEFAULT_DEADLINE_MS,
  maxCalls: DEFAULT_MAX_CALLS,
  maxInputSteps: DEFAULT_MAX_INPUT_STEPS,
  maxOutputSteps: DEFAULT_MAX_OUTPUT_STEPS,
} as const;

function validateBounds(options: {
  deadlineMs: number;
  maxCalls: number;
  maxInputSteps: number;
  maxOutputSteps: number;
  successesPerLevel: number;
  headroom: number;
  startInputTokens: number;
  startOutputTokens: number;
  model: ProbeModelConfig;
}): void {
  const positive = (value: number, name: string): void => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`probe: ${name} must be finite and positive`);
  };
  positive(options.deadlineMs, 'deadlineMs');
  positive(options.maxCalls, 'maxCalls');
  positive(options.maxInputSteps, 'maxInputSteps');
  positive(options.maxOutputSteps, 'maxOutputSteps');
  positive(options.successesPerLevel, 'successesPerLevel');
  positive(options.startInputTokens, 'startInputTokens');
  positive(options.startOutputTokens, 'startOutputTokens');
  positive(options.model.inputBudget, 'inputBudget');
  positive(options.model.outputBudget, 'outputBudget');
  if (options.deadlineMs > PROBE_HARD_LIMITS.deadlineMs) {
    throw new Error(`probe: deadlineMs must not exceed ${PROBE_HARD_LIMITS.deadlineMs}`);
  }
  if (options.maxCalls > PROBE_HARD_LIMITS.maxCalls) {
    throw new Error(`probe: maxCalls must not exceed ${PROBE_HARD_LIMITS.maxCalls}`);
  }
  if (options.maxInputSteps > PROBE_HARD_LIMITS.maxInputSteps) {
    throw new Error(`probe: maxInputSteps must not exceed ${PROBE_HARD_LIMITS.maxInputSteps}`);
  }
  if (options.maxOutputSteps > PROBE_HARD_LIMITS.maxOutputSteps) {
    throw new Error(`probe: maxOutputSteps must not exceed ${PROBE_HARD_LIMITS.maxOutputSteps}`);
  }
  if (!Number.isFinite(options.headroom) || options.headroom <= 0 || options.headroom > 1) {
    throw new Error('probe: headroom must be in (0, 1]');
  }
}

export function makePrompt(tokens: number): string {
  const target = Math.max(1, Math.ceil(tokens));
  return `Synthetic Morph rate probe. Reply with the single word ok.\n${'a'.repeat(target * 4)}`;
}

function zero(): WindowTotals {
  return { uncachedIn: 0, out: 0 };
}

function add(a: WindowTotals, b: WindowTotals): WindowTotals {
  return { uncachedIn: a.uncachedIn + b.uncachedIn, out: a.out + b.out };
}

function capExplanatory(combined: WindowTotals, caps: { uncachedIn: number; out: number }, headroom: number): boolean {
  return combined.uncachedIn >= caps.uncachedIn * headroom || combined.out >= caps.out * headroom;
}

function classify(
  haltReason: string | null,
  records: ProbeRecord[],
  caps: { uncachedIn: number; out: number },
  headroom: number,
  successes: number,
): { judgment: ProbeJudgment; ceiling: ProbeCeiling } {
  const emptyCeiling: ProbeCeiling = {
    proven: false,
    repeatable: false,
    capExplanatory: false,
    belowThresholdSuccesses: successes,
    threshold: null,
  };

  if (haltReason === 'second-429') {
    const last = records[records.length - 1];
    const previous = records[records.length - 2];
    const repeatable = Boolean(last && previous && last.status === 429 && previous.status === 429);
    const threshold = last?.windows.combined ?? null;
    const explanatory = threshold ? capExplanatory(threshold, caps, headroom) : false;
    const proven = repeatable && explanatory && successes > 0;
    return {
      judgment: proven ? 'ceiling' : 'cap-not-explanatory',
      ceiling: {
        proven,
        repeatable,
        capExplanatory: explanatory,
        belowThresholdSuccesses: successes,
        threshold,
      },
    };
  }

  if (haltReason === null) {
    return { judgment: 'no-ceiling-observed', ceiling: emptyCeiling };
  }

  return { judgment: 'inconclusive', ceiling: emptyCeiling };
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const {
    model,
    transport,
    clock,
    caps,
    headroom = 0.95,
    deadlineMs = DEFAULT_DEADLINE_MS,
    maxCalls = DEFAULT_MAX_CALLS,
    maxInputSteps = DEFAULT_MAX_INPUT_STEPS,
    maxOutputSteps = DEFAULT_MAX_OUTPUT_STEPS,
    startInputTokens = DEFAULT_START_INPUT_TOKENS,
    startOutputTokens = DEFAULT_START_OUTPUT_TOKENS,
    successesPerLevel = DEFAULT_SUCCESSES_PER_LEVEL,
  } = options;

  const startedAt = clock.now();
  const deadline = startedAt + deadlineMs;
  const probeWindow = new RollingWindow(60_000);
  const records: ProbeRecord[] = [];

  let calls = 0;
  let inputStep = 0;
  let outputStep = 0;
  let targetInput = Math.max(1, startInputTokens);
  let targetOutput = Math.max(1, startOutputTokens);
  let successesAtLevel = 0;
  let successes = 0;
  let lastWas429 = false;
  let haltReason: string | null = null;
  let lastLive = zero();

  for (;;) {
    if (clock.now() >= deadline) {
      haltReason = 'deadline';
      break;
    }
    if (calls >= maxCalls) {
      haltReason = 'call-cap';
      break;
    }
    if (inputStep >= maxInputSteps || outputStep >= maxOutputSteps) {
      haltReason = 'step-cap';
      break;
    }

    let live: LiveUsage;
    try {
      live = await transport.getLiveUsage();
    } catch {
      haltReason = 'live-load-guard';
      break;
    }
    lastLive = { uncachedIn: live.uncachedIn, out: live.out };

    const probeTotals = probeWindow.totals(clock.now());
    const combined = add(lastLive, probeTotals);

    if (probeTotals.uncachedIn >= model.inputBudget || probeTotals.out >= model.outputBudget) {
      haltReason = 'budget';
      break;
    }
    if (
      lastLive.uncachedIn >= caps.uncachedIn * headroom ||
      lastLive.out >= caps.out * headroom ||
      combined.uncachedIn >= caps.uncachedIn * headroom ||
      combined.out >= caps.out * headroom
    ) {
      haltReason = 'live-load-guard';
      break;
    }

    const started = clock.now();
    let response: ProbeResponse;
    try {
      response = await transport.postChat({
        model: model.model,
        prompt: makePrompt(targetInput),
        maxTokens: targetOutput,
      });
    } catch {
      haltReason = 'transport-error';
      break;
    }
    calls += 1;
    const latencyMs = clock.now() - started;

    records.push({
      call: calls,
      model: model.model,
      step: { input: inputStep, output: outputStep },
      target: { inputTokens: targetInput, outputTokens: targetOutput },
      status: response.status,
      latencyMs,
      retryAfterMs: response.retryAfterMs,
      usage: response.usage,
      windows: {
        live: lastLive,
        probe: probeTotals,
        combined,
      },
    });

    if (response.status === 429) {
      if (lastWas429) {
        haltReason = 'second-429';
        break;
      }
      lastWas429 = true;
      const wait = Math.max(0, response.retryAfterMs ?? 0);
      if (clock.now() + wait >= deadline) {
        haltReason = 'deadline';
        break;
      }
      if (wait > 0) await clock.sleep(wait);
      continue;
    }

    lastWas429 = false;

    if (response.status !== 200) {
      haltReason = `status-${response.status}`;
      break;
    }
    if (!response.usage) {
      haltReason = 'missing-usage';
      break;
    }

    const usage = response.usage;
    const uncachedIn = Math.max(0, usage.promptTokens - usage.cachedTokens);
    probeWindow.add({ t: clock.now(), uncachedIn, out: usage.completionTokens });
    successes += 1;
    successesAtLevel += 1;

    if (successesAtLevel >= successesPerLevel) {
      inputStep += 1;
      outputStep += 1;
      successesAtLevel = 0;
      targetInput = Math.max(
        targetInput + 1,
        Math.min(model.inputBudget, Math.ceil(Math.max(1, usage.promptTokens) * 2)),
      );
      targetOutput = Math.max(
        targetOutput + 1,
        Math.min(model.outputBudget, Math.ceil(Math.max(1, usage.completionTokens) * 2)),
      );
    }
  }

  const endedAt = clock.now();
  const probeTotals = probeWindow.totals(endedAt);
  const combined = add(lastLive, probeTotals);
  const { judgment, ceiling } = classify(haltReason, records, caps, headroom, successes);

  return {
    model: model.model,
    group: model.group,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    calls,
    steps: { input: inputStep, output: outputStep },
    budgets: { input: model.inputBudget, output: model.outputBudget },
    caps,
    headroom,
    haltReason,
    judgment,
    ceiling,
    windows: {
      live: lastLive,
      probe: probeTotals,
      combined,
    },
    records,
  };
}

const FORBIDDEN_KEYS = new Set(['prompt', 'body', 'apiKey', 'api_key', 'authorization', 'messages']);

/**
 * The result is already built from status/usage/window numbers only. This is a final guard so a
 * future field cannot accidentally carry a request payload or a credential into a report.
 */
export function sanitizeResult(result: ProbeResult): ProbeResult {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        out[key] = walk(child);
      }
      return out;
    }
    return value;
  };
  return walk(result) as ProbeResult;
}
