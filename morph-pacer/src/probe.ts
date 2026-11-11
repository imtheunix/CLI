import { readFileSync } from 'node:fs';

import { RealClock, type Clock } from './clock.js';
import { expandHome } from './config.js';
import { estimateInput } from './pacer.js';
import { parseJsonUsage } from './usage.js';
import { RollingWindow } from './windows.js';

export interface ProbeCaps {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  deadlineMs: number;
}

export interface ProbeGuard {
  maxLiveUncachedIn: number;
  maxLiveOut: number;
  maxCombinedUncachedIn: number;
  maxCombinedOut: number;
}

export interface ProbeConfig {
  enabled: boolean;
  model: string;
  group: string;
  endpoint: string;
  usageUrl: string;
  usageTimeoutMs: number;
  requestTimeoutMs: number;
  apiKeyFile: string;
  inputSteps: number[];
  outputSteps: number[];
  inputPhaseMaxOutputTokens: number;
  outputPhaseInputTokens: number;
  successesBeforeEscalation: number;
  maxConsecutive429: number;
  proposedCeiling: { input: number; output: number };
  caps: ProbeCaps;
  guard: ProbeGuard;
}

export interface LiveUsage {
  uncachedIn: number;
  out: number;
}

export interface ProbeHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ProbeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ProbeHttpResponse>;

export interface ProbeDeps {
  clock: Clock;
  fetch: ProbeFetch;
  readApiKey: (path: string) => string;
  readLiveUsage: (config: ProbeConfig) => Promise<LiveUsage | null>;
}

export type ProbeStopReason =
  | 'disabled'
  | 'completed'
  | 'deadline'
  | 'call_cap'
  | 'input_token_cap'
  | 'output_token_cap'
  | 'live_usage_unavailable'
  | 'live_load_guard'
  | 'two_consecutive_429'
  | 'missing_usage'
  | 'transport_uncertainty'
  | 'http_error'
  | 'missing_api_key';

export interface ProbeUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  uncachedInputTokens: number;
}

export interface ProbeCallRecord {
  index: number;
  phase: 'input' | 'output';
  step: number;
  targetInputTokens: number;
  targetOutputTokens: number;
  maxTokens: number;
  promptBytes: number;
  status: number | null;
  retryAfterMs: number | null;
  provider429: boolean;
  ceilingNotExplanatory: boolean;
  usage: ProbeUsageRecord | null;
  liveOccupancy: LiveUsage | null;
  probeOccupancy: LiveUsage;
  reservation: LiveUsage;
  combinedOccupancy: LiveUsage | null;
  pacerWaitMs: number;
  providerWaitMs: number;
  outcome: 'success' | 'provider_429' | 'missing_usage' | 'transport_error' | 'http_error';
  error: string | null;
}

export interface ProbePhaseSummary {
  successes: number;
  maxSuccessTarget: number | null;
  maxSuccessActualInput: number | null;
  maxSuccessActualOutput: number | null;
  rateLimits: number;
  ceilingExplanatory: boolean | null;
}

export interface ProbeSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUncachedInputTokens: number;
  provider429Count: number;
  input: ProbePhaseSummary;
  output: ProbePhaseSummary;
  pacerWaitMsTotal: number;
  providerWaitMsTotal: number;
}

export interface ProbeReport {
  schema: 'morph-ceiling-probe/v1';
  status: 'disabled' | 'completed' | 'stopped';
  stopReason: ProbeStopReason;
  model: string;
  group: string;
  startedAt: string;
  endedAt: string;
  caps: ProbeCaps;
  guard: ProbeGuard;
  proposedCeiling: { input: number; output: number };
  calls: ProbeCallRecord[];
  summary: ProbeSummary;
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  enabled: false,
  model: 'morph-dsv41flash-1017',
  group: 'deepseek',
  endpoint: 'https://api.morphllm.com/v1/chat/completions',
  usageUrl: 'http://127.0.0.1:8198/pacer/usage',
  usageTimeoutMs: 2_000,
  requestTimeoutMs: 120_000,
  apiKeyFile: '~/.config/morph/api_key',
  inputSteps: [1_024, 8_192, 32_768, 131_072, 524_288, 1_048_576, 1_572_864, 2_097_152],
  outputSteps: [256, 1_024, 4_096, 16_384, 32_768, 65_536],
  inputPhaseMaxOutputTokens: 16,
  outputPhaseInputTokens: 64,
  successesBeforeEscalation: 3,
  maxConsecutive429: 2,
  proposedCeiling: { input: 2_103_237, output: 76_559 },
  caps: {
    maxCalls: 60,
    maxInputTokens: 8_000_000,
    maxOutputTokens: 200_000,
    deadlineMs: 1_200_000,
  },
  guard: {
    maxLiveUncachedIn: 1_000_000,
    maxLiveOut: 30_000,
    maxCombinedUncachedIn: 1_500_000,
    maxCombinedOut: 50_000,
  },
};

const FILLER = 'synthetic capacity probe filler token ';

export function buildInputPrompt(targetTokens: number): string {
  const repeats = Math.max(1, Math.ceil(targetTokens / 6));
  return `Synthetic capacity probe. Reply with the single word OK.\n\n${FILLER.repeat(repeats)}`;
}

export function buildOutputPrompt(targetTokens: number): string {
  return `Synthetic capacity probe. Output exactly ${targetTokens} repetitions of the word "token", separated by single spaces. Do not add any other text.`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function emptyPhaseSummary(): ProbePhaseSummary {
  return {
    successes: 0,
    maxSuccessTarget: null,
    maxSuccessActualInput: null,
    maxSuccessActualOutput: null,
    rateLimits: 0,
    ceilingExplanatory: null,
  };
}

function emptySummary(): ProbeSummary {
  return {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalUncachedInputTokens: 0,
    provider429Count: 0,
    input: emptyPhaseSummary(),
    output: emptyPhaseSummary(),
    pacerWaitMsTotal: 0,
    providerWaitMsTotal: 0,
  };
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function sanitizeError(error: unknown, apiKey: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function defaultReadApiKey(path: string): string {
  return readFileSync(expandHome(path), 'utf8').trim();
}

const defaultFetch: ProbeFetch = (url, init) =>
  (globalThis.fetch as unknown as ProbeFetch)(url, init);

async function fetchWithTimeout(
  fetchImpl: ProbeFetch,
  url: string,
  init: Parameters<ProbeFetch>[1],
  timeoutMs: number,
): Promise<ProbeHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function defaultReadLiveUsage(
  config: ProbeConfig,
  fetchImpl: ProbeFetch,
): Promise<LiveUsage | null> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      config.usageUrl,
      { method: 'GET', headers: { accept: 'application/json' } },
      config.usageTimeoutMs,
    );
    if (response.status !== 200) return null;
    const parsed = JSON.parse(await response.text()) as {
      groups?: Record<string, { window?: { uncached_in?: unknown; out?: unknown } }>;
    };
    const window = parsed.groups?.[config.group]?.window;
    if (!window) return null;
    const uncachedIn = Number(window.uncached_in);
    const out = Number(window.out);
    if (!Number.isFinite(uncachedIn) || !Number.isFinite(out)) return null;
    if (uncachedIn < 0 || out < 0) return null;
    return { uncachedIn, out };
  } catch {
    return null;
  }
}

interface BuiltRequest {
  body: string;
  promptBytes: number;
  maxTokens: number;
  targetInputTokens: number;
  targetOutputTokens: number;
}

function buildRequest(config: ProbeConfig, phase: 'input' | 'output', step: number): BuiltRequest {
  const prompt =
    phase === 'input' ? buildInputPrompt(step) : buildOutputPrompt(step);
  const maxTokens =
    phase === 'input' ? config.inputPhaseMaxOutputTokens : step;
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  });
  return {
    body,
    promptBytes: Buffer.byteLength(body, 'utf8'),
    maxTokens,
    targetInputTokens: phase === 'input' ? step : config.outputPhaseInputTokens,
    targetOutputTokens: maxTokens,
  };
}

function phaseCeiling(config: ProbeConfig, phase: 'input' | 'output'): number {
  return phase === 'input' ? config.proposedCeiling.input : config.proposedCeiling.output;
}

function phaseTarget(record: ProbeCallRecord): number {
  return record.phase === 'input' ? record.targetInputTokens : record.targetOutputTokens;
}

function summarizePhase(
  records: ProbeCallRecord[],
  phase: 'input' | 'output',
  proposedCeiling: number,
): ProbePhaseSummary {
  const phaseRecords = records.filter((record) => record.phase === phase);
  const successes = phaseRecords.filter((record) => record.outcome === 'success');
  const rateLimits = phaseRecords.filter((record) => record.provider429);
  const explanatory = rateLimits.filter((record) => phaseTarget(record) >= proposedCeiling);
  return {
    successes: successes.length,
    maxSuccessTarget:
      successes.length === 0
        ? null
        : Math.max(...successes.map((record) => phaseTarget(record))),
    maxSuccessActualInput:
      successes.length === 0
        ? null
        : Math.max(...successes.map((record) => record.usage?.inputTokens ?? 0)),
    maxSuccessActualOutput:
      successes.length === 0
        ? null
        : Math.max(...successes.map((record) => record.usage?.outputTokens ?? 0)),
    rateLimits: rateLimits.length,
    ceilingExplanatory: rateLimits.length === 0 ? null : explanatory.length >= 2,
  };
}

export async function runProbe(
  config: ProbeConfig,
  deps: Partial<ProbeDeps> = {},
): Promise<ProbeReport> {
  const clock = deps.clock ?? new RealClock();
  const fetchImpl = deps.fetch ?? defaultFetch;
  const readApiKey = deps.readApiKey ?? defaultReadApiKey;
  const readLiveUsage =
    deps.readLiveUsage ?? ((cfg: ProbeConfig) => defaultReadLiveUsage(cfg, fetchImpl));

  const startedAt = clock.now();
  const base = {
    schema: 'morph-ceiling-probe/v1' as const,
    model: config.model,
    group: config.group,
    startedAt: iso(startedAt),
    caps: config.caps,
    guard: config.guard,
    proposedCeiling: config.proposedCeiling,
  };

  if (!config.enabled) {
    return {
      ...base,
      status: 'disabled',
      stopReason: 'disabled',
      endedAt: iso(startedAt),
      calls: [],
      summary: emptySummary(),
    };
  }

  let apiKey: string;
  try {
    apiKey = readApiKey(config.apiKeyFile);
  } catch {
    apiKey = '';
  }
  if (!apiKey) {
    return {
      ...base,
      status: 'stopped',
      stopReason: 'missing_api_key',
      endedAt: iso(clock.now()),
      calls: [],
      summary: emptySummary(),
    };
  }

  const deadline = startedAt + config.caps.deadlineMs;
  const probeWindow = new RollingWindow(60_000);
  const calls: ProbeCallRecord[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalUncachedInputTokens = 0;
  let pacerWaitMsTotal = 0;
  let providerWaitMsTotal = 0;
  let consecutive429 = 0;
  let stopReason: ProbeStopReason | null = null;

  const phases: Array<{ phase: 'input' | 'output'; steps: number[] }> = [
    { phase: 'input', steps: config.inputSteps },
    { phase: 'output', steps: config.outputSteps },
  ];

  outer: for (const { phase, steps } of phases) {
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      let successes = 0;

      while (successes < config.successesBeforeEscalation) {
        if (clock.now() >= deadline) {
          stopReason = 'deadline';
          break outer;
        }
        if (calls.length >= config.caps.maxCalls) {
          stopReason = 'call_cap';
          break outer;
        }
        if (totalInputTokens >= config.caps.maxInputTokens) {
          stopReason = 'input_token_cap';
          break outer;
        }
        if (totalOutputTokens >= config.caps.maxOutputTokens) {
          stopReason = 'output_token_cap';
          break outer;
        }

        const request = buildRequest(config, phase, step);
        const reservation: LiveUsage = {
          uncachedIn: estimateInput(request.promptBytes),
          out: phase === 'output' ? step : config.inputPhaseMaxOutputTokens,
        };
        if (totalInputTokens + reservation.uncachedIn > config.caps.maxInputTokens) {
          stopReason = 'input_token_cap';
          break outer;
        }
        if (totalOutputTokens + reservation.out > config.caps.maxOutputTokens) {
          stopReason = 'output_token_cap';
          break outer;
        }

        const pacerStarted = clock.now();
        const live = await readLiveUsage(config);
        const pacerWaitMs = clock.now() - pacerStarted;
        pacerWaitMsTotal += pacerWaitMs;
        if (!live) {
          stopReason = 'live_usage_unavailable';
          break outer;
        }

        const probeTotals = probeWindow.totals(clock.now());
        const combined: LiveUsage = {
          uncachedIn: live.uncachedIn + probeTotals.uncachedIn + reservation.uncachedIn,
          out: live.out + probeTotals.out + reservation.out,
        };
        if (
          live.uncachedIn > config.guard.maxLiveUncachedIn ||
          live.out > config.guard.maxLiveOut ||
          combined.uncachedIn > config.guard.maxCombinedUncachedIn ||
          combined.out > config.guard.maxCombinedOut
        ) {
          stopReason = 'live_load_guard';
          break outer;
        }

        const callStarted = clock.now();
        let response: ProbeHttpResponse | null = null;
        let error: string | null = null;
        try {
          response = await fetchWithTimeout(
            fetchImpl,
            config.endpoint,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
              },
              body: request.body,
            },
            config.requestTimeoutMs,
          );
        } catch (caught) {
          error = sanitizeError(caught, apiKey);
        }
        const providerWaitMs = clock.now() - callStarted;
        providerWaitMsTotal += providerWaitMs;

        const index = calls.length + 1;
        if (!response) {
          calls.push({
            index,
            phase,
            step: stepIndex + 1,
            targetInputTokens: request.targetInputTokens,
            targetOutputTokens: request.targetOutputTokens,
            maxTokens: request.maxTokens,
            promptBytes: request.promptBytes,
            status: null,
            retryAfterMs: null,
            provider429: false,
            ceilingNotExplanatory: false,
            usage: null,
            liveOccupancy: live,
            probeOccupancy: probeTotals,
            reservation,
            combinedOccupancy: combined,
            pacerWaitMs,
            providerWaitMs,
            outcome: 'transport_error',
            error,
          });
          stopReason = 'transport_uncertainty';
          break outer;
        }

        const status = response.status;
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), clock.now());
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        const parsedUsage = parseJsonUsage(text);
        const usage: ProbeUsageRecord | null = parsedUsage
          ? {
              inputTokens: parsedUsage.promptTokens,
              outputTokens: parsedUsage.completionTokens,
              cachedTokens: parsedUsage.cachedTokens,
              uncachedInputTokens: Math.max(
                0,
                parsedUsage.promptTokens - parsedUsage.cachedTokens,
              ),
            }
          : null;
        const provider429 = status === 429;
        const target = phase === 'input' ? request.targetInputTokens : request.targetOutputTokens;
        const ceilingNotExplanatory = provider429 && target < phaseCeiling(config, phase);

        let outcome: ProbeCallRecord['outcome'];
        if (provider429) outcome = 'provider_429';
        else if (status >= 200 && status < 300) outcome = usage ? 'success' : 'missing_usage';
        else outcome = 'http_error';

        calls.push({
          index,
          phase,
          step: stepIndex + 1,
          targetInputTokens: request.targetInputTokens,
          targetOutputTokens: request.targetOutputTokens,
          maxTokens: request.maxTokens,
          promptBytes: request.promptBytes,
          status,
          retryAfterMs,
          provider429,
          ceilingNotExplanatory,
          usage,
          liveOccupancy: live,
          probeOccupancy: probeTotals,
          reservation,
          combinedOccupancy: combined,
          pacerWaitMs,
          providerWaitMs,
          outcome,
          error,
        });

        if (provider429) {
          consecutive429 += 1;
          if (consecutive429 >= config.maxConsecutive429) {
            stopReason = 'two_consecutive_429';
            break outer;
          }
          break;
        }

        consecutive429 = 0;

        if (status >= 200 && status < 300) {
          if (!usage) {
            stopReason = 'missing_usage';
            break outer;
          }
          probeWindow.add({
            t: clock.now(),
            uncachedIn: usage.uncachedInputTokens,
            out: usage.outputTokens,
          });
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
          totalUncachedInputTokens += usage.uncachedInputTokens;
          successes += 1;
          if (totalInputTokens > config.caps.maxInputTokens) {
            stopReason = 'input_token_cap';
            break outer;
          }
          if (totalOutputTokens > config.caps.maxOutputTokens) {
            stopReason = 'output_token_cap';
            break outer;
          }
        } else {
          stopReason = 'http_error';
          break outer;
        }
      }
    }
  }

  if (!stopReason) stopReason = 'completed';

  const summary: ProbeSummary = {
    totalCalls: calls.length,
    totalInputTokens,
    totalOutputTokens,
    totalUncachedInputTokens,
    provider429Count: calls.filter((record) => record.provider429).length,
    input: summarizePhase(calls, 'input', config.proposedCeiling.input),
    output: summarizePhase(calls, 'output', config.proposedCeiling.output),
    pacerWaitMsTotal,
    providerWaitMsTotal,
  };

  return {
    ...base,
    status: stopReason === 'completed' ? 'completed' : 'stopped',
    stopReason,
    endedAt: iso(clock.now()),
    calls,
    summary,
  };
}
