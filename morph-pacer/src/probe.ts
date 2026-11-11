import { readFileSync } from 'node:fs';

import type { Clock } from './clock.js';
import { expandHome } from './config.js';
import { RollingWindow } from './windows.js';

export const MORPH_CHAT_COMPLETIONS_URL = 'https://api.morphllm.com/v1/chat/completions';
export const DEFAULT_LIVE_USAGE_URL = 'http://127.0.0.1:8198/pacer/usage';
export const DEFAULT_API_KEY_FILE = '~/.config/morph/api_key';

export interface ProbeCaps {
  uncachedIn: number;
  out: number;
}

export interface ProbeLevel {
  input: number;
  output: number;
}

export const DEFAULT_PROBE_CAPS: ProbeCaps = { uncachedIn: 240_000, out: 32_000 };

/** Fractions of the per-model caps: 25%, 50% and 100%. */
export const DEFAULT_PROBE_LEVELS: ProbeLevel[] = [
  { input: 60_000, output: 8_000 },
  { input: 120_000, output: 16_000 },
  { input: 240_000, output: 32_000 },
];

export interface ProbeLimits {
  maxTotalMs: number;
  successesPerLevel: number;
  maxConsecutive429: number;
  headroom: number;
  pollMs: number;
  usageTimeoutMs: number;
  requestTimeoutMs: number;
  defaultRetryAfterMs: number;
}

export const DEFAULT_PROBE_LIMITS: ProbeLimits = {
  maxTotalMs: 20 * 60_000,
  successesPerLevel: 3,
  maxConsecutive429: 2,
  headroom: 1,
  pollMs: 1_000,
  usageTimeoutMs: 2_000,
  requestTimeoutMs: 120_000,
  defaultRetryAfterMs: 1_000,
};

export interface ProbeTransportRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface ProbeTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export type ProbeTransport = (request: ProbeTransportRequest) => Promise<ProbeTransportResponse>;

export const offlineTransport: ProbeTransport = async () => {
  throw new Error('morph probe: real transport is disabled (offline mode)');
};

export const fetchTransport: ProbeTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const headers: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
};

export interface LiveUsageGroup {
  models: string[];
  window: { uncached_in: number; out: number };
  caps?: { uncached_in: number; out: number };
}

export interface LiveUsageSnapshot {
  now?: string;
  groups: Record<string, LiveUsageGroup>;
}

export type LiveUsageFetcher = (url: string, timeoutMs: number) => Promise<LiveUsageSnapshot>;

export const fetchLiveUsage: LiveUsageFetcher = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`live usage HTTP ${response.status}`);
    return (await response.json()) as LiveUsageSnapshot;
  } finally {
    clearTimeout(timer);
  }
};

export type ProbeOutcome =
  | 'success'
  | 'rate_limited'
  | 'capacity_error'
  | 'missing_usage'
  | 'transport_error';

export interface ProbeCallRecord {
  level: number;
  planned: ProbeLevel;
  model: string;
  status: number | null;
  latencyMs: number;
  retryAfterMs: number | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  uncachedIn: number | null;
  out: number | null;
  occupancy: {
    probe: { uncachedIn: number; out: number };
    live: { uncachedIn: number; out: number };
    combined: { uncachedIn: number; out: number };
  };
  outcome: ProbeOutcome;
  error?: string;
}

export type ProbeConclusionKind =
  | 'dry_run'
  | 'completed'
  | 'repeatable_limit'
  | 'capacity_error'
  | 'missing_usage'
  | 'live_usage_unavailable'
  | 'load_guard'
  | 'deadline'
  | 'transport_error';

export interface ProbeConclusion {
  kind: ProbeConclusionKind;
  tested: boolean;
  level?: number;
  note: string;
  belowLimit429: boolean;
  belowThresholdSuccesses: boolean;
  maxSuccessfulInput: number;
  maxSuccessfulOutput: number;
}

export interface ProbeResult {
  mode: 'dry-run' | 'live';
  model: string;
  endpoint: string;
  levels: ProbeLevel[];
  limits: ProbeLimits;
  assumedCaps: ProbeCaps;
  calls: ProbeCallRecord[];
  observed: {
    probeWindow: { uncachedIn: number; out: number };
    liveWindow: { uncachedIn: number; out: number } | null;
    combined: { uncachedIn: number; out: number } | null;
  };
  conclusion: ProbeConclusion;
}

export interface ProbeOptions {
  model: string;
  clock: Clock;
  levels?: ProbeLevel[];
  caps?: ProbeCaps;
  limits?: Partial<ProbeLimits>;
  live?: boolean;
  dryRun?: boolean;
  transport?: ProbeTransport;
  liveUsage?: LiveUsageFetcher;
  usageUrl?: string;
  endpoint?: string;
  apiKey?: string;
  apiKeyFile?: string;
}

interface ParsedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

function parseUsage(body: string): ParsedUsage | null {
  try {
    const parsed = JSON.parse(body) as {
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      };
    };
    const usage = parsed.usage;
    if (
      !usage ||
      typeof usage.prompt_tokens !== 'number' ||
      typeof usage.completion_tokens !== 'number'
    ) {
      return null;
    }
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_tokens:
        typeof usage.prompt_tokens_details?.cached_tokens === 'number'
          ? usage.prompt_tokens_details.cached_tokens
          : 0,
    };
  } catch {
    return null;
  }
}

function parseRetryAfter(
  headers: Record<string, string | undefined>,
  now: number,
): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function findGroup(snapshot: LiveUsageSnapshot, model: string): LiveUsageGroup | null {
  for (const group of Object.values(snapshot.groups ?? {})) {
    if (Array.isArray(group.models) && group.models.includes(model)) return group;
  }
  return null;
}

export function syntheticPrompt(inputTokens: number): string {
  const targetChars = Math.max(1, Math.round(inputTokens * 4));
  const seed = 'The quick brown fox jumps over the lazy dog. ';
  const body = seed.repeat(Math.ceil(targetChars / seed.length)).slice(0, targetChars);
  return `${body}\nReply with the single word OK.`;
}

function buildBody(model: string, level: ProbeLevel): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: syntheticPrompt(level.input) }],
    max_tokens: level.output,
    temperature: 0,
    stream: false,
  });
}

function readApiKey(path: string): string {
  const key = readFileSync(expandHome(path), 'utf8').trim();
  if (!key) throw new Error(`morph probe: no API key in ${path}`);
  return key;
}

function emptyConclusion(kind: ProbeConclusionKind, note: string): ProbeConclusion {
  return {
    kind,
    tested: false,
    note,
    belowLimit429: false,
    belowThresholdSuccesses: false,
    maxSuccessfulInput: 0,
    maxSuccessfulOutput: 0,
  };
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const limits: ProbeLimits = { ...DEFAULT_PROBE_LIMITS, ...options.limits };
  const levels = options.levels ?? DEFAULT_PROBE_LEVELS;
  const caps = options.caps ?? DEFAULT_PROBE_CAPS;
  const endpoint = options.endpoint ?? MORPH_CHAT_COMPLETIONS_URL;
  const usageUrl = options.usageUrl ?? DEFAULT_LIVE_USAGE_URL;
  const live = options.live === true && options.dryRun !== true;
  const mode: ProbeResult['mode'] = live ? 'live' : 'dry-run';
  const probeWindow = new RollingWindow(60_000);
  const calls: ProbeCallRecord[] = [];
  let lastLive: { uncachedIn: number; out: number } | null = null;
  let consecutive429 = 0;
  let belowLimit429 = false;
  let maxSuccessfulInput = 0;
  let maxSuccessfulOutput = 0;

  const result = (conclusion: ProbeConclusion): ProbeResult => {
    const probe = probeWindow.totals(options.clock.now());
    return {
      mode,
      model: options.model,
      endpoint,
      levels,
      limits,
      assumedCaps: caps,
      calls,
      observed: {
        probeWindow: probe,
        liveWindow: lastLive,
        combined: lastLive
          ? {
              uncachedIn: lastLive.uncachedIn + probe.uncachedIn,
              out: lastLive.out + probe.out,
            }
          : null,
      },
      conclusion,
    };
  };

  if (!live) {
    return result(
      emptyConclusion(
        'dry_run',
        'dry run: no provider request, no API-key lookup and no live usage lookup',
      ),
    );
  }

  const transport = options.transport ?? fetchTransport;
  const liveUsage = options.liveUsage ?? fetchLiveUsage;
  let apiKey: string;
  try {
    apiKey = options.apiKey ?? readApiKey(options.apiKeyFile ?? DEFAULT_API_KEY_FILE);
  } catch (error) {
    return result(
      emptyConclusion('transport_error', `cannot read API key: ${(error as Error).message}`),
    );
  }

  const started = options.clock.now();
  const deadline = started + limits.maxTotalMs;

  const waitForAdmission = async (
    level: ProbeLevel,
  ): Promise<
    | { ok: true; live: { uncachedIn: number; out: number } }
    | { ok: false; reason: 'deadline' | 'live_usage_unavailable' | 'live_group_unavailable' }
  > => {
    for (;;) {
      if (options.clock.now() >= deadline) return { ok: false, reason: 'deadline' };
      let snapshot: LiveUsageSnapshot;
      try {
        snapshot = await liveUsage(usageUrl, limits.usageTimeoutMs);
      } catch {
        return { ok: false, reason: 'live_usage_unavailable' };
      }
      const group = findGroup(snapshot, options.model);
      if (!group) return { ok: false, reason: 'live_group_unavailable' };
      const liveTotals = {
        uncachedIn: Number(group.window?.uncached_in ?? 0),
        out: Number(group.window?.out ?? 0),
      };
      const probe = probeWindow.totals(options.clock.now());
      const combined = {
        uncachedIn: liveTotals.uncachedIn + probe.uncachedIn,
        out: liveTotals.out + probe.out,
      };
      const inputLimit = caps.uncachedIn * limits.headroom;
      const outLimit = caps.out * limits.headroom;
      if (
        combined.uncachedIn + level.input <= inputLimit &&
        combined.out + level.output <= outLimit
      ) {
        return { ok: true, live: liveTotals };
      }
      const wait = Math.max(1, Math.min(limits.pollMs, deadline - options.clock.now()));
      await options.clock.sleep(wait);
    }
  };

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    let successes = 0;
    while (successes < limits.successesPerLevel) {
      if (options.clock.now() >= deadline) {
        return result({
          ...emptyConclusion('deadline', `deadline reached at level ${levelIndex}`),
          belowLimit429,
          belowThresholdSuccesses: maxSuccessfulInput > 0,
          maxSuccessfulInput,
          maxSuccessfulOutput,
        });
      }

      const admission = await waitForAdmission(level);
      if (!admission.ok) {
        const kind: ProbeConclusionKind =
          admission.reason === 'live_usage_unavailable'
            ? 'live_usage_unavailable'
            : admission.reason === 'live_group_unavailable'
              ? 'load_guard'
              : 'deadline';
        return result({
          ...emptyConclusion(
            kind,
            admission.reason === 'live_usage_unavailable'
              ? 'live admission state unavailable; stopped before a request'
              : admission.reason === 'live_group_unavailable'
                ? `live usage has no group for ${options.model}; stopped before a request`
                : `deadline reached while waiting for admission at level ${levelIndex}`,
          ),
          belowLimit429,
          belowThresholdSuccesses: maxSuccessfulInput > 0,
          maxSuccessfulInput,
          maxSuccessfulOutput,
        });
      }
      lastLive = admission.live;

      const callStarted = options.clock.now();
      let response: ProbeTransportResponse;
      try {
        response = await transport({
          url: endpoint,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: buildBody(options.model, level),
          timeoutMs: limits.requestTimeoutMs,
        });
      } catch (error) {
        const probe = probeWindow.totals(options.clock.now());
        calls.push({
          level: levelIndex,
          planned: level,
          model: options.model,
          status: null,
          latencyMs: options.clock.now() - callStarted,
          retryAfterMs: null,
          usage: null,
          uncachedIn: null,
          out: null,
          occupancy: { probe, live: admission.live, combined: {
            uncachedIn: probe.uncachedIn + admission.live.uncachedIn,
            out: probe.out + admission.live.out,
          } },
          outcome: 'transport_error',
          error: (error as Error).message,
        });
        return result({
          ...emptyConclusion(
            'transport_error',
            `transport failed at level ${levelIndex}; not a ceiling claim`,
          ),
          belowLimit429,
          belowThresholdSuccesses: maxSuccessfulInput > 0,
          maxSuccessfulInput,
          maxSuccessfulOutput,
        });
      }

      const latencyMs = options.clock.now() - callStarted;
      const retryAfterMs = parseRetryAfter(response.headers, options.clock.now());
      const usage = response.status >= 200 && response.status < 300
        ? parseUsage(response.body)
        : null;
      const probe = probeWindow.totals(options.clock.now());
      const combined = {
        uncachedIn: probe.uncachedIn + admission.live.uncachedIn,
        out: probe.out + admission.live.out,
      };
      const record: ProbeCallRecord = {
        level: levelIndex,
        planned: level,
        model: options.model,
        status: response.status,
        latencyMs,
        retryAfterMs,
        usage: usage
          ? {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
            }
          : null,
        uncachedIn: usage ? Math.max(0, usage.prompt_tokens - usage.cached_tokens) : null,
        out: usage ? usage.completion_tokens : null,
        occupancy: { probe, live: admission.live, combined },
        outcome: 'success',
      };
      calls.push(record);

      if (response.status >= 200 && response.status < 300) {
        if (!usage) {
          record.outcome = 'missing_usage';
          return result({
            ...emptyConclusion(
              'missing_usage',
              `HTTP ${response.status} without usage at level ${levelIndex}; stopped without inventing numbers`,
            ),
            belowLimit429,
            belowThresholdSuccesses: maxSuccessfulInput > 0,
            maxSuccessfulInput,
            maxSuccessfulOutput,
          });
        }
        const had429 = consecutive429 > 0;
        record.outcome = 'success';
        probeWindow.add({
          t: options.clock.now(),
          uncachedIn: record.uncachedIn as number,
          out: record.out as number,
        });
        successes += 1;
        consecutive429 = 0;
        if (had429) belowLimit429 = true;
        maxSuccessfulInput = Math.max(maxSuccessfulInput, level.input);
        maxSuccessfulOutput = Math.max(maxSuccessfulOutput, level.output);
        continue;
      }

      if (response.status === 429) {
        record.outcome = 'rate_limited';
        consecutive429 += 1;
        if (consecutive429 >= limits.maxConsecutive429) {
          return result({
            kind: 'repeatable_limit',
            tested: true,
            level: levelIndex,
            note: `two consecutive 429s at level ${levelIndex} (${level.input} input / ${level.output} output); ${successes} success(es) at this level`,
            belowLimit429,
            belowThresholdSuccesses: maxSuccessfulInput > 0,
            maxSuccessfulInput,
            maxSuccessfulOutput,
          });
        }
        const wait = retryAfterMs ?? limits.defaultRetryAfterMs;
        if (options.clock.now() + wait > deadline) {
          return result({
            ...emptyConclusion(
              'deadline',
              `Retry-After ${wait}ms would pass the deadline at level ${levelIndex}`,
            ),
            belowLimit429,
            belowThresholdSuccesses: maxSuccessfulInput > 0,
            maxSuccessfulInput,
            maxSuccessfulOutput,
          });
        }
        await options.clock.sleep(wait);
        continue;
      }

      record.outcome = 'capacity_error';
      return result({
        ...emptyConclusion(
          'capacity_error',
          `HTTP ${response.status} at level ${levelIndex}; capacity error, not a ceiling claim`,
        ),
        belowLimit429,
        belowThresholdSuccesses: maxSuccessfulInput > 0,
        maxSuccessfulInput,
        maxSuccessfulOutput,
      });
    }
  }

  return result({
    kind: 'completed',
    tested: true,
    note: belowLimit429
      ? 'all levels completed; a 429 was seen but was not repeatable, so it is not a ceiling claim'
      : 'all levels completed with the required successes; no repeatable limit observed',
    belowLimit429,
    belowThresholdSuccesses: maxSuccessfulInput > 0,
    maxSuccessfulInput,
    maxSuccessfulOutput,
  });
}
