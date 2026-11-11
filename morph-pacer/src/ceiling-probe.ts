import { readFileSync } from 'node:fs';

import type { Clock } from './clock.js';
import { DEFAULT_GROUPS, expandHome, type Caps } from './config.js';
import { parseJsonUsage } from './usage.js';
import { RollingWindow } from './windows.js';

export const PROBE_SCHEMA = 'morph-ceiling-probe/v1';

export interface ProbeCaps {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  deadlineMs: number;
}

export interface ProbeConfig {
  /** Off by default: no key read, no usage fetch and no provider call until explicitly enabled. */
  enabled: boolean;
  model: string;
  providerUrl: string;
  apiKeyFile: string;
  pacerUsageUrl: string;
  pacerTimeoutMs: number;
  requestTimeoutMs: number;
  /** Live occupancy above this fraction of the proposed ceiling fails closed. */
  liveGuardFraction: number;
  /** Longest the probe waits for its own rolling window to decay before giving up. */
  maxWaitMs: number;
  pollMs: number;
  successesBeforeEscalation: number;
  maxConsecutive429: number;
  inputSteps: number[];
  outputSteps: number[];
  inputPhaseOutputTokens: number;
  outputPhaseInputTokens: number;
  caps: ProbeCaps;
  /** Optional override; defaults to the pacer group caps for the model. */
  proposedCeiling?: Caps;
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  enabled: false,
  model: 'morph-dsv41flash-1017',
  providerUrl: 'https://api.morphllm.com/v1/chat/completions',
  apiKeyFile: '~/.config/morph/api_key',
  pacerUsageUrl: 'http://127.0.0.1:8198/pacer/usage',
  pacerTimeoutMs: 2_000,
  requestTimeoutMs: 120_000,
  liveGuardFraction: 0.5,
  maxWaitMs: 90_000,
  pollMs: 1_000,
  successesBeforeEscalation: 3,
  maxConsecutive429: 2,
  inputSteps: [1_000, 10_000, 50_000, 200_000, 500_000, 1_000_000, 1_500_000, 2_000_000],
  outputSteps: [100, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000],
  inputPhaseOutputTokens: 16,
  outputPhaseInputTokens: 1_000,
  caps: {
    maxCalls: 60,
    maxInputTokens: 12_000_000,
    maxOutputTokens: 500_000,
    deadlineMs: 20 * 60_000,
  },
};

export interface LiveOccupancy {
  uncachedIn: number;
  out: number;
}

export interface ProbeDeps {
  clock: Clock;
  fetch: typeof fetch;
  readApiKey: (path: string) => string;
  readLiveUsage: () => Promise<LiveOccupancy>;
}

export type StopReason =
  | 'disabled'
  | 'completed'
  | 'deadline'
  | 'call-cap'
  | 'token-cap'
  | 'two-consecutive-429'
  | 'missing-usage'
  | 'transport-uncertainty'
  | 'live-load-guard'
  | 'proposed-ceiling-reached'
  | 'key-unavailable'
  | 'http-error';

export type CallClassification =
  | 'success'
  | 'ceiling-not-explanatory'
  | 'ceiling-consistent'
  | 'http-error'
  | 'missing-usage'
  | 'transport-uncertainty';

export interface ProbeCallRecord {
  phase: 'input' | 'output';
  step: number;
  attempt: number;
  startedAt: string;
  durationMs: number;
  request: {
    model: string;
    targetInputTokens: number;
    targetOutputTokens: number;
    bodyBytes: number;
  };
  status: number | null;
  retryAfterMs: number | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    uncachedIn: number;
  } | null;
  liveOccupancy: LiveOccupancy | null;
  combinedOccupancy: LiveOccupancy | null;
  provider429: boolean;
  pacerWaitMs: number;
  providerLatencyMs: number;
  classification: CallClassification;
  error?: string;
}

export interface ProbeThreshold {
  phase: 'input' | 'output';
  step: number;
  evidence: 'two-consecutive-429';
  classification: 'ceiling-not-explanatory' | 'ceiling-consistent';
}

export interface ProbeReport {
  schema: typeof PROBE_SCHEMA;
  enabled: boolean;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: StopReason;
  stopDetail: string | null;
  caps: ProbeCaps;
  proposedCeiling: Caps;
  liveGuard: Caps;
  calls: ProbeCallRecord[];
  summary: {
    callCount: number;
    successCount: number;
    provider429Count: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalUncachedIn: number;
    totalOut: number;
    pacerWaitMsTotal: number;
    providerLatencyMsTotal: number;
    input: { maxSuccessTokens: number; successes: number };
    output: { maxSuccessTokens: number; successes: number };
    threshold: ProbeThreshold | null;
  };
}

export function proposedCeilingFor(model: string): Caps {
  for (const group of Object.values(DEFAULT_GROUPS)) {
    if (group.models.includes(model)) return { ...group.caps };
  }
  return { uncachedIn: Number.MAX_SAFE_INTEGER, out: Number.MAX_SAFE_INTEGER };
}

export function pacerGroupFor(model: string): string | null {
  for (const [key, group] of Object.entries(DEFAULT_GROUPS)) {
    if (group.models.includes(model)) return key;
  }
  return null;
}

export function createPacerUsageSource(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  group: string,
): () => Promise<LiveOccupancy> {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await fetchFn(url, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`pacer usage status ${response.status}`);
    const parsed = (await response.json()) as {
      groups?: Record<string, { window?: { uncached_in?: number; out?: number } }>;
    };
    const window = parsed.groups?.[group]?.window;
    if (!window) throw new Error(`pacer usage has no group ${group}`);
    return {
      uncachedIn: Number(window.uncached_in ?? 0),
      out: Number(window.out ?? 0),
    };
  };
}

export function readApiKeyFromFile(path: string): string {
  const key = readFileSync(expandHome(path), 'utf8').trim();
  if (key.length === 0) throw new Error('empty API key file');
  return key;
}

export function buildSyntheticPrompt(targetInputTokens: number): string {
  const unit = 'Synthetic probe payload with no workspace or customer data. ';
  const chars = Math.max(1, Math.ceil(targetInputTokens * 4));
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function finitePositive(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validateProbeConfig(config: ProbeConfig): void {
  if (!config.model) throw new Error('probe: model is required');
  if (!config.providerUrl) throw new Error('probe: providerUrl is required');
  if (!config.apiKeyFile) throw new Error('probe: apiKeyFile is required');
  if (!config.pacerUsageUrl) throw new Error('probe: pacerUsageUrl is required');
  for (const [name, value] of Object.entries({
    pacerTimeoutMs: config.pacerTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxWaitMs: config.maxWaitMs,
    pollMs: config.pollMs,
    successesBeforeEscalation: config.successesBeforeEscalation,
    maxConsecutive429: config.maxConsecutive429,
    inputPhaseOutputTokens: config.inputPhaseOutputTokens,
    outputPhaseInputTokens: config.outputPhaseInputTokens,
  })) {
    if (!finitePositive(value)) throw new Error(`probe: ${name} must be a finite positive number`);
  }
  if (!(config.liveGuardFraction > 0 && config.liveGuardFraction <= 1)) {
    throw new Error('probe: liveGuardFraction must be in (0, 1]');
  }
  for (const [name, value] of Object.entries(config.caps)) {
    if (!finitePositive(value)) throw new Error(`probe: caps.${name} must be a finite positive number`);
  }
  for (const [name, steps] of [
    ['inputSteps', config.inputSteps],
    ['outputSteps', config.outputSteps],
  ] as const) {
    if (steps.length === 0 || steps.some((step) => !finitePositive(step))) {
      throw new Error(`probe: ${name} must be a non-empty list of finite positive numbers`);
    }
  }
}

function iso(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

function guardFor(ceiling: Caps, fraction: number): Caps {
  return {
    uncachedIn: Math.floor(ceiling.uncachedIn * fraction),
    out: Math.floor(ceiling.out * fraction),
  };
}

function validOccupancy(value: LiveOccupancy | null | undefined): value is LiveOccupancy {
  return (
    !!value &&
    Number.isFinite(value.uncachedIn) &&
    Number.isFinite(value.out) &&
    value.uncachedIn >= 0 &&
    value.out >= 0
  );
}

function classify(
  status: number,
  usage: ProbeCallRecord['usage'],
  targetInputTokens: number,
  targetOutputTokens: number,
  ceiling: Caps,
): CallClassification {
  if (status === 429) {
    const below =
      targetInputTokens < ceiling.uncachedIn && targetOutputTokens < ceiling.out;
    return below ? 'ceiling-not-explanatory' : 'ceiling-consistent';
  }
  if (status >= 200 && status < 300) return usage ? 'success' : 'missing-usage';
  return 'http-error';
}

async function fetchWithTimeout(
  deps: ProbeDeps,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await deps.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function runProbe(
  config: ProbeConfig,
  deps: ProbeDeps,
): Promise<ProbeReport> {
  validateProbeConfig(config);
  const started = deps.clock.now();
  const ceiling = config.proposedCeiling ?? proposedCeilingFor(config.model);
  const liveGuard = guardFor(ceiling, config.liveGuardFraction);
  const calls: ProbeCallRecord[] = [];
  const probeWindow = new RollingWindow(60_000);
  let stopReason: StopReason = 'completed';
  let stopDetail: string | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalUncachedIn = 0;
  let totalOut = 0;
  let pacerWaitMsTotal = 0;
  let providerLatencyMsTotal = 0;
  let successCount = 0;
  let provider429Count = 0;
  let consecutive429 = 0;
  let last429: { phase: 'input' | 'output'; step: number } | null = null;
  let threshold: ProbeThreshold | null = null;
  const input = { maxSuccessTokens: 0, successes: 0 };
  const output = { maxSuccessTokens: 0, successes: 0 };

  const finish = (): ProbeReport => ({
    schema: PROBE_SCHEMA,
    enabled: config.enabled,
    model: config.model,
    startedAt: new Date(started).toISOString(),
    finishedAt: iso(deps.clock),
    durationMs: deps.clock.now() - started,
    stopReason,
    stopDetail,
    caps: { ...config.caps },
    proposedCeiling: { ...ceiling },
    liveGuard,
    calls,
    summary: {
      callCount: calls.length,
      successCount,
      provider429Count,
      totalPromptTokens,
      totalCompletionTokens,
      totalUncachedIn,
      totalOut,
      pacerWaitMsTotal,
      providerLatencyMsTotal,
      input,
      output,
      threshold,
    },
  });

  if (!config.enabled) {
    stopReason = 'disabled';
    return finish();
  }

  let apiKey: string;
  try {
    apiKey = deps.readApiKey(config.apiKeyFile);
  } catch {
    stopReason = 'key-unavailable';
    return finish();
  }

  const phases: Array<{ phase: 'input' | 'output'; steps: number[] }> = [
    { phase: 'input', steps: config.inputSteps },
    { phase: 'output', steps: config.outputSteps },
  ];

  outer: for (const { phase, steps } of phases) {
    for (const step of steps) {
      let successesAtStep = 0;
      let attempt = 0;
      while (successesAtStep < config.successesBeforeEscalation) {
        if (deps.clock.now() - started >= config.caps.deadlineMs) {
          stopReason = 'deadline';
          break outer;
        }
        if (calls.length >= config.caps.maxCalls) {
          stopReason = 'call-cap';
          break outer;
        }
        if (
          totalPromptTokens >= config.caps.maxInputTokens ||
          totalCompletionTokens >= config.caps.maxOutputTokens
        ) {
          stopReason = 'token-cap';
          break outer;
        }

        const targetInputTokens =
          phase === 'input' ? step : config.outputPhaseInputTokens;
        const targetOutputTokens =
          phase === 'input' ? config.inputPhaseOutputTokens : step;
        const prompt = buildSyntheticPrompt(targetInputTokens);
        const body = JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: targetOutputTokens,
          temperature: 0,
          stream: false,
        });
        const bodyBytes = Buffer.byteLength(body, 'utf8');
        const reservedIn = Math.max(targetInputTokens, Math.ceil(bodyBytes / 4));
        const reservedOut = targetOutputTokens;

        const waitStart = deps.clock.now();
        let live: LiveOccupancy | null = null;
        for (;;) {
          if (deps.clock.now() - started >= config.caps.deadlineMs) {
            stopReason = 'deadline';
            break outer;
          }
          try {
            live = await deps.readLiveUsage();
          } catch {
            stopReason = 'live-load-guard';
            stopDetail = 'pacer usage unavailable';
            break outer;
          }
          if (!validOccupancy(live)) {
            stopReason = 'live-load-guard';
            stopDetail = 'pacer usage invalid';
            break outer;
          }
          if (live.uncachedIn > liveGuard.uncachedIn || live.out > liveGuard.out) {
            stopReason = 'live-load-guard';
            stopDetail = 'live occupancy over guard';
            break outer;
          }
          const probeTotals = probeWindow.totals(deps.clock.now());
          const combinedIn = live.uncachedIn + probeTotals.uncachedIn;
          const combinedOut = live.out + probeTotals.out;
          if (
            combinedIn + reservedIn <= ceiling.uncachedIn &&
            combinedOut + reservedOut <= ceiling.out
          ) {
            break;
          }
          if (deps.clock.now() - waitStart >= config.maxWaitMs) {
            stopReason = 'proposed-ceiling-reached';
            stopDetail = 'probe window did not decay below the proposed ceiling';
            break outer;
          }
          await deps.clock.sleep(config.pollMs);
        }
        const pacerWaitMs = deps.clock.now() - waitStart;
        pacerWaitMsTotal += pacerWaitMs;

        const callStarted = deps.clock.now();
        attempt += 1;
        let response: Response;
        try {
          response = await fetchWithTimeout(
            deps,
            config.providerUrl,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
              },
              body,
            },
            config.requestTimeoutMs,
          );
        } catch (error) {
          const record: ProbeCallRecord = {
            phase,
            step,
            attempt,
            startedAt: new Date(callStarted).toISOString(),
            durationMs: deps.clock.now() - callStarted,
            request: {
              model: config.model,
              targetInputTokens,
              targetOutputTokens,
              bodyBytes,
            },
            status: null,
            retryAfterMs: null,
            usage: null,
            liveOccupancy: live,
            combinedOccupancy: null,
            provider429: false,
            pacerWaitMs,
            providerLatencyMs: deps.clock.now() - callStarted,
            classification: 'transport-uncertainty',
            error: (error as Error).name === 'AbortError' ? 'request timeout' : 'transport error',
          };
          calls.push(record);
          providerLatencyMsTotal += record.providerLatencyMs;
          stopReason = 'transport-uncertainty';
          stopDetail = record.error ?? null;
          break outer;
        }

        const providerLatencyMs = deps.clock.now() - callStarted;
        providerLatencyMsTotal += providerLatencyMs;
        const status = response.status;
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after'),
          deps.clock.now(),
        );

        let usage: ProbeCallRecord['usage'] = null;
        let responseError: string | undefined;
        if (status >= 200 && status < 300) {
          try {
            const text = await response.text();
            const parsed = parseJsonUsage(text);
            if (parsed) {
              const uncachedIn = Math.max(0, parsed.promptTokens - parsed.cachedTokens);
              usage = {
                promptTokens: parsed.promptTokens,
                completionTokens: parsed.completionTokens,
                cachedTokens: parsed.cachedTokens,
                uncachedIn,
              };
            }
          } catch {
            responseError = 'response read failed';
          }
        }

        if (usage) {
          probeWindow.add({
            t: deps.clock.now(),
            uncachedIn: usage.uncachedIn,
            out: usage.completionTokens,
          });
          totalPromptTokens += usage.promptTokens;
          totalCompletionTokens += usage.completionTokens;
          totalUncachedIn += usage.uncachedIn;
          totalOut += usage.completionTokens;
        }

        const probeTotals = probeWindow.totals(deps.clock.now());
        const combinedOccupancy: LiveOccupancy = {
          uncachedIn: live.uncachedIn + probeTotals.uncachedIn,
          out: live.out + probeTotals.out,
        };
        const classification = classify(
          status,
          usage,
          targetInputTokens,
          targetOutputTokens,
          ceiling,
        );
        const record: ProbeCallRecord = {
          phase,
          step,
          attempt,
          startedAt: new Date(callStarted).toISOString(),
          durationMs: deps.clock.now() - callStarted,
          request: {
            model: config.model,
            targetInputTokens,
            targetOutputTokens,
            bodyBytes,
          },
          status,
          retryAfterMs,
          usage,
          liveOccupancy: live,
          combinedOccupancy,
          provider429: status === 429,
          pacerWaitMs,
          providerLatencyMs,
          classification,
        };
        if (responseError) record.error = responseError;
        calls.push(record);

        if (status === 429) {
          provider429Count += 1;
          consecutive429 += 1;
          last429 = { phase, step };
          if (consecutive429 >= config.maxConsecutive429) {
            threshold = {
              phase,
              step,
              evidence: 'two-consecutive-429',
              classification:
                classification === 'ceiling-not-explanatory'
                  ? 'ceiling-not-explanatory'
                  : 'ceiling-consistent',
            };
            stopReason = 'two-consecutive-429';
            stopDetail = 'second consecutive provider 429';
            break outer;
          }
          continue;
        }

        consecutive429 = 0;
        last429 = null;

        if (status >= 200 && status < 300) {
          if (!usage) {
            stopReason = 'missing-usage';
            stopDetail = responseError ?? 'successful response without usage';
            break outer;
          }
          successCount += 1;
          successesAtStep += 1;
          const bucket = phase === 'input' ? input : output;
          bucket.successes += 1;
          bucket.maxSuccessTokens = Math.max(bucket.maxSuccessTokens, step);
          continue;
        }

        stopReason = 'http-error';
        stopDetail = `provider status ${status}`;
        break outer;
      }
    }
  }

  if (stopReason === 'completed' && last429) {
    stopDetail = 'probe ended after a single 429';
  }

  return finish();
}
