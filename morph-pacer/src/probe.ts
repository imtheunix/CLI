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

export type ProbeSweep = 'output' | 'input';

/**
 * A level is a target measured in provider tokens, never in planned characters.
 * `output` levels require the actual completion to reach `output` while keeping
 * actual uncached input at or below `input`. `input` levels require the actual
 * uncached input to reach `input` while the actual completion reaches `output`.
 */
export interface ProbeLevel {
  sweep: ProbeSweep;
  input: number;
  output: number;
}

export const DEFAULT_PROBE_CAPS: ProbeCaps = { uncachedIn: 240_000, out: 32_000 };

/**
 * The next live protocol, prepared but not executed here: output first
 * (128 -> 512 -> 2048 actual completion tokens with <= 2k actual uncached
 * input), then input (50k -> 100k -> 200k actual uncached input with a fixed
 * 128 actual completion).
 */
export const DEFAULT_PROBE_LEVELS: ProbeLevel[] = [
  { sweep: 'output', input: 2_000, output: 128 },
  { sweep: 'output', input: 2_000, output: 512 },
  { sweep: 'output', input: 2_000, output: 2_048 },
  { sweep: 'input', input: 50_000, output: 128 },
  { sweep: 'input', input: 100_000, output: 128 },
  { sweep: 'input', input: 200_000, output: 128 },
];

export interface ProbeLimits {
  maxTotalMs: number;
  successesPerLevel: number;
  maxAttemptsPerLevel: number;
  maxCalls: number;
  maxTokens: number;
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
  maxAttemptsPerLevel: 5,
  maxCalls: 30,
  maxTokens: 2_000_000,
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
  | 'below_threshold'
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
  | 'inconclusive'
  | 'repeatable_limit'
  | 'capacity_error'
  | 'missing_usage'
  | 'live_usage_unavailable'
  | 'load_guard'
  | 'deadline'
  | 'budget'
  | 'transport_error';

export interface ProbeConclusion {
  kind: ProbeConclusionKind;
  tested: boolean;
  level?: number;
  note: string;
  belowLimit429: boolean;
  belowThresholdSuccesses: boolean;
  /** Largest actual uncached input among calls that met their level threshold. */
  maxSuccessfulUncachedIn: number;
  /** Largest actual completion among calls that met their level threshold. */
  maxSuccessfulOutput: number;
  /** Largest actual uncached input seen in any response with usage. */
  maxObservedUncachedIn: number;
  /** Largest actual completion seen in any response with usage. */
  maxObservedOutput: number;
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

const WORDS = [
  'amber',
  'basalt',
  'cobalt',
  'dune',
  'ember',
  'fjord',
  'granite',
  'harbor',
  'indigo',
  'juniper',
  'kelp',
  'lumen',
  'meadow',
  'nimbus',
  'onyx',
  'prairie',
  'quartz',
  'ridge',
  'slate',
  'tundra',
  'umber',
  'valley',
  'willow',
  'xenon',
  'yarrow',
  'zephyr',
];

const LONG_OUTPUT_INSTRUCTION =
  'Write the counting sequence starting at 1, one integer per line, increasing by one each line. ' +
  'Do not add commentary, headings or a conclusion. Keep going until the output limit is reached.';

/**
 * Deterministic but wholly unique filler. Every request gets a different seed,
 * so the body is not a repeated prompt with a nonce prefix: the whole payload
 * differs and cannot be served from the provider prompt cache.
 */
function uniqueText(chars: number, seed: number): string {
  let state = seed >>> 0;
  let out = '';
  while (out.length < chars) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = (t ^ (t >>> 14)) >>> 0;
    out += `${WORDS[value % WORDS.length]} `;
  }
  return out.slice(0, chars);
}

interface BuiltBody {
  body: string;
  contentChars: number;
}

function buildBody(
  model: string,
  level: ProbeLevel,
  seed: number,
  charsPerToken: number,
): BuiltBody {
  const safety = level.sweep === 'output' ? 0.9 : 1.02;
  const inputChars = Math.max(
    1,
    Math.round(level.input * charsPerToken * safety),
  );
  const content = `${uniqueText(inputChars, seed)}\n\n${LONG_OUTPUT_INSTRUCTION}`;
  return {
    contentChars: content.length,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: level.output,
      temperature: 0,
      stream: false,
    }),
  };
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
    maxSuccessfulUncachedIn: 0,
    maxSuccessfulOutput: 0,
    maxObservedUncachedIn: 0,
    maxObservedOutput: 0,
  };
}

function meetsThreshold(level: ProbeLevel, uncachedIn: number, out: number): boolean {
  const inputOk =
    level.sweep === 'output' ? uncachedIn <= level.input : uncachedIn >= level.input;
  return inputOk && out >= level.output;
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
  let maxSuccessfulUncachedIn = 0;
  let maxSuccessfulOutput = 0;
  let maxObservedUncachedIn = 0;
  let maxObservedOutput = 0;
  let usedTokens = 0;
  let charsPerToken = 4;
  let seed = 0x9e3779b9;

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

  const conclude = (
    kind: ProbeConclusionKind,
    note: string,
    tested: boolean,
    level?: number,
  ): ProbeResult =>
    result({
      kind,
      tested,
      ...(level === undefined ? {} : { level }),
      note,
      belowLimit429,
      belowThresholdSuccesses: maxSuccessfulOutput > 0,
      maxSuccessfulUncachedIn,
      maxSuccessfulOutput,
      maxObservedUncachedIn,
      maxObservedOutput,
    });

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
    return conclude(
      'transport_error',
      `cannot read API key: ${(error as Error).message}`,
      false,
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
      const window = group.window as
        | { uncached_in?: unknown; out?: unknown }
        | null
        | undefined;
      if (
        !window ||
        typeof window.uncached_in !== 'number' ||
        typeof window.out !== 'number' ||
        !Number.isFinite(window.uncached_in) ||
        !Number.isFinite(window.out)
      ) {
        return { ok: false, reason: 'live_usage_unavailable' };
      }
      const liveTotals = {
        uncachedIn: window.uncached_in,
        out: window.out,
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
    let attempts = 0;
    while (successes < limits.successesPerLevel) {
      if (options.clock.now() >= deadline) {
        return conclude('deadline', `deadline reached at level ${levelIndex}`, false, levelIndex);
      }
      if (calls.length >= limits.maxCalls) {
        return conclude(
          'budget',
          `call cap ${limits.maxCalls} reached at level ${levelIndex}`,
          false,
          levelIndex,
        );
      }
      if (usedTokens >= limits.maxTokens) {
        return conclude(
          'budget',
          `token cap ${limits.maxTokens} reached at level ${levelIndex}`,
          false,
          levelIndex,
        );
      }
      if (attempts >= limits.maxAttemptsPerLevel) {
        return conclude(
          'inconclusive',
          `level ${levelIndex} (${level.sweep} ${level.input} in / ${level.output} out) did not reach its actual-token threshold in ${attempts} attempts; ${successes} success(es)`,
          false,
          levelIndex,
        );
      }

      const admission = await waitForAdmission(level);
      if (!admission.ok) {
        const kind: ProbeConclusionKind =
          admission.reason === 'live_usage_unavailable'
            ? 'live_usage_unavailable'
            : admission.reason === 'live_group_unavailable'
              ? 'load_guard'
              : 'deadline';
        return conclude(
          kind,
          admission.reason === 'live_usage_unavailable'
            ? 'live admission state unavailable; stopped before a request'
            : admission.reason === 'live_group_unavailable'
              ? `live usage has no group for ${options.model}; stopped before a request`
              : `deadline reached while waiting for admission at level ${levelIndex}`,
          false,
          levelIndex,
        );
      }
      lastLive = admission.live;

      seed = (seed + 0x9e3779b9) >>> 0;
      const built = buildBody(options.model, level, seed, charsPerToken);
      attempts += 1;
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
          body: built.body,
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
          occupancy: {
            probe,
            live: admission.live,
            combined: {
              uncachedIn: probe.uncachedIn + admission.live.uncachedIn,
              out: probe.out + admission.live.out,
            },
          },
          outcome: 'transport_error',
          error: (error as Error).message,
        });
        return conclude(
          'transport_error',
          `transport failed at level ${levelIndex}; not a ceiling claim`,
          false,
          levelIndex,
        );
      }

      const latencyMs = options.clock.now() - callStarted;
      const retryAfterMs = parseRetryAfter(response.headers, options.clock.now());
      const usage =
        response.status >= 200 && response.status < 300 ? parseUsage(response.body) : null;
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
          return conclude(
            'missing_usage',
            `HTTP ${response.status} without usage at level ${levelIndex}; stopped without inventing numbers`,
            false,
            levelIndex,
          );
        }

        if (
          usage.prompt_tokens < 0 ||
          usage.completion_tokens < 0 ||
          usage.cached_tokens < 0
        ) {
          record.outcome = 'missing_usage';
          record.usage = null;
          record.uncachedIn = null;
          record.out = null;
          return conclude(
            'missing_usage',
            `HTTP ${response.status} with negative usage at level ${levelIndex}; stopped without eroding the window`,
            false,
            levelIndex,
          );
        }

        const observedRatio = built.contentChars / usage.prompt_tokens;
        if (Number.isFinite(observedRatio) && observedRatio > 0.5 && observedRatio < 20) {
          charsPerToken = observedRatio;
        }

        const uncachedIn = record.uncachedIn as number;
        const out = record.out as number;
        usedTokens += uncachedIn + out;
        maxObservedUncachedIn = Math.max(maxObservedUncachedIn, uncachedIn);
        maxObservedOutput = Math.max(maxObservedOutput, out);
        probeWindow.add({ t: options.clock.now(), uncachedIn, out });
        const had429 = consecutive429 > 0;
        consecutive429 = 0;

        if (!meetsThreshold(level, uncachedIn, out)) {
          record.outcome = 'below_threshold';
          if (usedTokens >= limits.maxTokens) {
            return conclude(
              'budget',
              `token cap ${limits.maxTokens} reached at level ${levelIndex}`,
              false,
              levelIndex,
            );
          }
          continue;
        }

        record.outcome = 'success';
        successes += 1;
        if (had429) belowLimit429 = true;
        maxSuccessfulUncachedIn = Math.max(maxSuccessfulUncachedIn, uncachedIn);
        maxSuccessfulOutput = Math.max(maxSuccessfulOutput, out);
        if (usedTokens >= limits.maxTokens) {
          const finalSuccess =
            successes >= limits.successesPerLevel && levelIndex === levels.length - 1;
          if (!finalSuccess) {
            return conclude(
              'budget',
              `token cap ${limits.maxTokens} reached at level ${levelIndex}`,
              false,
              levelIndex,
            );
          }
        }
        continue;
      }

      if (response.status === 429) {
        record.outcome = 'rate_limited';
        consecutive429 += 1;
        if (consecutive429 >= limits.maxConsecutive429) {
          return conclude(
            'repeatable_limit',
            `two consecutive 429s at level ${levelIndex} (${level.input} input / ${level.output} output); ${successes} success(es) at this level`,
            true,
            levelIndex,
          );
        }
        const wait = retryAfterMs ?? limits.defaultRetryAfterMs;
        if (options.clock.now() + wait > deadline) {
          return conclude(
            'deadline',
            `Retry-After ${wait}ms would pass the deadline at level ${levelIndex}`,
            false,
            levelIndex,
          );
        }
        await options.clock.sleep(wait);
        continue;
      }

      record.outcome = 'capacity_error';
      return conclude(
        'capacity_error',
        `HTTP ${response.status} at level ${levelIndex}; capacity error, not a ceiling claim`,
        false,
        levelIndex,
      );
    }
  }

  return conclude(
    'completed',
    belowLimit429
      ? 'all levels reached their actual-token thresholds; a 429 was seen but was not repeatable, so it is not a ceiling claim'
      : 'all levels reached their actual-token thresholds; no repeatable limit observed',
    true,
  );
}
