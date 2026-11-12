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

export type ProbeMode = 'input' | 'output';

/**
 * One measured step. `target` is the actual token count the sweep must reach in
 * the swept dimension. `companion` is the other dimension: for an output sweep
 * it is the maximum actual uncached input allowed, and for an input sweep it is
 * the fixed actual output the request must return.
 */
export interface ProbeLevel {
  mode: ProbeMode;
  target: number;
  companion: number;
}

export type PlannedLevel =
  | ProbeLevel
  | { mode: 'calibration'; target: number; companion: number };

export const DEFAULT_PROBE_CAPS: ProbeCaps = { uncachedIn: 240_000, out: 32_000 };

/**
 * The next live protocol, prepared but not executed by this job: output first
 * (128 -> 512 -> 2048 actual completion tokens with <= 2k actual uncached
 * input), then input (50k -> 100k -> 200k actual uncached input with a fixed
 * 128 actual output).
 */
export const DEFAULT_PROBE_LEVELS: ProbeLevel[] = [
  { mode: 'output', target: 128, companion: 2_000 },
  { mode: 'output', target: 512, companion: 2_000 },
  { mode: 'output', target: 2_048, companion: 2_000 },
  { mode: 'input', target: 50_000, companion: 128 },
  { mode: 'input', target: 100_000, companion: 128 },
  { mode: 'input', target: 200_000, companion: 128 },
];

export interface ProbeLimits {
  maxTotalMs: number;
  successesPerLevel: number;
  attemptsPerLevel: number;
  maxConsecutive429: number;
  headroom: number;
  pollMs: number;
  usageTimeoutMs: number;
  requestTimeoutMs: number;
  defaultRetryAfterMs: number;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export const DEFAULT_PROBE_LIMITS: ProbeLimits = {
  maxTotalMs: 20 * 60_000,
  successesPerLevel: 3,
  attemptsPerLevel: 4,
  maxConsecutive429: 2,
  headroom: 1,
  pollMs: 1_000,
  usageTimeoutMs: 2_000,
  requestTimeoutMs: 120_000,
  defaultRetryAfterMs: 1_000,
  maxCalls: 40,
  maxInputTokens: 3_000_000,
  maxOutputTokens: 50_000,
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
  | 'inconclusive'
  | 'rate_limited'
  | 'capacity_error'
  | 'missing_usage'
  | 'transport_error';

export interface ProbeCallRecord {
  level: number;
  planned: PlannedLevel;
  model: string;
  status: number | null;
  latencyMs: number;
  retryAfterMs: number | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
  } | null;
  uncachedIn: number | null;
  out: number | null;
  bodyChars: number;
  occupancy: {
    probe: { uncachedIn: number; out: number };
    live: { uncachedIn: number; out: number };
    combined: { uncachedIn: number; out: number };
  };
  outcome: ProbeOutcome;
  inconclusiveReason?: string;
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
  | 'transport_error'
  | 'call_cap'
  | 'token_cap'
  | 'inconclusive';

export interface ProbeConclusion {
  kind: ProbeConclusionKind;
  tested: boolean;
  level?: number;
  note: string;
  belowLimit429: boolean;
  belowThresholdSuccesses: boolean;
  maxSuccessfulInput: number;
  maxSuccessfulOutput: number;
  observedMaxInput: number;
  observedMaxOutput: number;
}

export interface ProbeResult {
  mode: 'dry-run' | 'live';
  model: string;
  endpoint: string;
  levels: ProbeLevel[];
  limits: ProbeLimits;
  assumedCaps: ProbeCaps;
  calibration: {
    charsPerToken: number;
    promptTokens: number;
    bodyChars: number;
  } | null;
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

const FILLER_WORDS = [
  'amber',
  'basalt',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'granite',
  'harbor',
  'indigo',
  'jasper',
  'kelp',
  'lumen',
  'marble',
  'nectar',
  'onyx',
  'pearl',
  'quartz',
  'raven',
  'saffron',
  'topaz',
  'umber',
  'violet',
  'willow',
  'xenon',
  'yarrow',
  'zephyr',
  'acorn',
  'birch',
  'cedar',
  'dune',
  'elm',
  'fern',
  'glade',
  'hazel',
  'iris',
  'juniper',
  'kite',
  'larch',
  'moss',
  'nettle',
  'oak',
  'pine',
  'reed',
  'sage',
  'thorn',
  'vine',
  'wren',
  'yew',
  'zinc',
  'atlas',
  'brisk',
  'calm',
  'dense',
  'eager',
  'faint',
  'glad',
  'hollow',
  'ivory',
  'jolly',
  'keen',
  'lucid',
  'mellow',
  'noble',
  'open',
  'plain',
  'quiet',
  'rapid',
  'solid',
  'tidy',
  'urban',
  'vivid',
  'warm',
  'young',
  'zesty',
  'bold',
  'crisp',
  'dry',
  'even',
  'fair',
  'grand',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic filler whose whole body changes with the seed, not just a
 * nonce prefix. Two calls with different seeds share no long prefix, so a
 * provider prompt cache cannot turn a large input request into a cache hit.
 */
export function uniqueFiller(seed: number, chars: number): string {
  const rand = mulberry32(seed);
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = FILLER_WORDS[Math.floor(rand() * FILLER_WORDS.length)];
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ').slice(0, Math.max(0, chars));
}

const LONG_FORM_INSTRUCTION =
  '\n\nWrite the integers from 1 to 100000, one per line, with no other text.';
const CALIBRATION_INSTRUCTION = '\n\nReply with OK.';

function buildBody(
  model: string,
  level: PlannedLevel,
  charsPerToken: number,
  seed: number,
): string {
  const instruction =
    level.mode === 'calibration' ? CALIBRATION_INSTRUCTION : LONG_FORM_INSTRUCTION;
  const targetTokens =
    level.mode === 'input'
      ? level.target
      : level.mode === 'output'
        ? Math.round(level.companion * 0.75)
        : level.target;
  const targetChars = Math.max(
    1,
    Math.round(targetTokens * charsPerToken) - instruction.length,
  );
  const filler = uniqueFiller(seed, targetChars);
  const maxTokens =
    level.mode === 'input'
      ? level.companion + 32
      : level.mode === 'output'
        ? level.target + 32
        : level.companion;
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: `${filler}${instruction}` }],
    max_tokens: maxTokens,
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
    observedMaxInput: 0,
    observedMaxOutput: 0,
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
  let observedMaxInput = 0;
  let observedMaxOutput = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let charsPerToken = 4;
  let calibration: ProbeResult['calibration'] = null;
  let callCounter = 0;

  const makeConclusion = (
    kind: ProbeConclusionKind,
    note: string,
    extra: Partial<ProbeConclusion> = {},
  ): ProbeConclusion => ({
    kind,
    tested: false,
    note,
    belowLimit429,
    belowThresholdSuccesses: maxSuccessfulInput > 0,
    maxSuccessfulInput,
    maxSuccessfulOutput,
    observedMaxInput,
    observedMaxOutput,
    ...extra,
  });

  const result = (conclusion: ProbeConclusion): ProbeResult => {
    const probe = probeWindow.totals(options.clock.now());
    return {
      mode,
      model: options.model,
      endpoint,
      levels,
      limits,
      assumedCaps: caps,
      calibration,
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
    estimatedInput: number,
    estimatedOutput: number,
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
        combined.uncachedIn + estimatedInput <= inputLimit &&
        combined.out + estimatedOutput <= outLimit
      ) {
        return { ok: true, live: liveTotals };
      }
      const wait = Math.max(1, Math.min(limits.pollMs, deadline - options.clock.now()));
      await options.clock.sleep(wait);
    }
  };

  type CallStop = { kind: ProbeConclusionKind; note: string };
  interface CallResult {
    record?: ProbeCallRecord;
    stop?: CallStop;
  }

  const runOneCall = async (
    levelIndex: number,
    planned: PlannedLevel,
    body: string,
    estimatedInput: number,
    estimatedOutput: number,
  ): Promise<CallResult> => {
    if (options.clock.now() >= deadline) {
      return {
        stop: { kind: 'deadline', note: `deadline reached before level ${levelIndex}` },
      };
    }
    if (calls.length >= limits.maxCalls) {
      return {
        stop: {
          kind: 'call_cap',
          note: `call cap ${limits.maxCalls} reached before level ${levelIndex}`,
        },
      };
    }
    if (totalInputTokens + estimatedInput > limits.maxInputTokens) {
      return {
        stop: {
          kind: 'token_cap',
          note: `input token cap ${limits.maxInputTokens} would be exceeded before level ${levelIndex}`,
        },
      };
    }
    if (totalOutputTokens + estimatedOutput > limits.maxOutputTokens) {
      return {
        stop: {
          kind: 'token_cap',
          note: `output token cap ${limits.maxOutputTokens} would be exceeded before level ${levelIndex}`,
        },
      };
    }

    const admission = await waitForAdmission(estimatedInput, estimatedOutput);
    if (!admission.ok) {
      const kind: ProbeConclusionKind =
        admission.reason === 'live_usage_unavailable'
          ? 'live_usage_unavailable'
          : admission.reason === 'live_group_unavailable'
            ? 'load_guard'
            : 'deadline';
      const note =
        admission.reason === 'live_usage_unavailable'
          ? 'live admission state unavailable; stopped before a request'
          : admission.reason === 'live_group_unavailable'
            ? `live usage has no group for ${options.model}; stopped before a request`
            : `deadline reached while waiting for admission at level ${levelIndex}`;
      return { stop: { kind, note } };
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
        body,
        timeoutMs: limits.requestTimeoutMs,
      });
    } catch (error) {
      const probe = probeWindow.totals(options.clock.now());
      const record: ProbeCallRecord = {
        level: levelIndex,
        planned,
        model: options.model,
        status: null,
        latencyMs: options.clock.now() - callStarted,
        retryAfterMs: null,
        usage: null,
        uncachedIn: null,
        out: null,
        bodyChars: body.length,
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
      };
      calls.push(record);
      return {
        record,
        stop: {
          kind: 'transport_error',
          note: `transport failed at level ${levelIndex}; not a ceiling claim`,
        },
      };
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
      planned,
      model: options.model,
      status: response.status,
      latencyMs,
      retryAfterMs,
      usage: usage
        ? {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cached_tokens: usage.cached_tokens,
          }
        : null,
      uncachedIn: usage ? Math.max(0, usage.prompt_tokens - usage.cached_tokens) : null,
      out: usage ? usage.completion_tokens : null,
      bodyChars: body.length,
      occupancy: { probe, live: admission.live, combined },
      outcome: 'success',
    };
    calls.push(record);

    if (usage) {
      probeWindow.add({
        t: options.clock.now(),
        uncachedIn: record.uncachedIn as number,
        out: record.out as number,
      });
      totalInputTokens += usage.prompt_tokens;
      totalOutputTokens += usage.completion_tokens;
      if (levelIndex >= 0) {
        observedMaxInput = Math.max(observedMaxInput, record.uncachedIn as number);
        observedMaxOutput = Math.max(observedMaxOutput, record.out as number);
      }
      charsPerToken = body.length / usage.prompt_tokens;
      if (totalInputTokens > limits.maxInputTokens) {
        return {
          record,
          stop: {
            kind: 'token_cap',
            note: `input token cap ${limits.maxInputTokens} exceeded at level ${levelIndex}`,
          },
        };
      }
      if (totalOutputTokens > limits.maxOutputTokens) {
        return {
          record,
          stop: {
            kind: 'token_cap',
            note: `output token cap ${limits.maxOutputTokens} exceeded at level ${levelIndex}`,
          },
        };
      }
    }

    return { record };
  };

  const calibrationLevel: PlannedLevel = {
    mode: 'calibration',
    target: 1_000,
    companion: 8,
  };
  let calibrationRecord: ProbeCallRecord | undefined;
  for (let attempt = 0; attempt < limits.maxConsecutive429 + 1; attempt += 1) {
    const body = buildBody(options.model, calibrationLevel, charsPerToken, callCounter++);
    const estimatedInput = Math.ceil(body.length / charsPerToken);
    const call = await runOneCall(-1, calibrationLevel, body, estimatedInput, 8);
    if (call.stop) {
      return result(makeConclusion(call.stop.kind, call.stop.note));
    }
    calibrationRecord = call.record;
    if (!calibrationRecord) {
      return result(makeConclusion('transport_error', 'calibration produced no record'));
    }
    if (calibrationRecord.status === 429) {
      belowLimit429 = true;
      consecutive429 += 1;
      if (consecutive429 >= limits.maxConsecutive429) {
        return result(
          makeConclusion(
            'repeatable_limit',
            'two consecutive 429s during calibration; no level was measured',
            { tested: true },
          ),
        );
      }
      const wait = calibrationRecord.retryAfterMs ?? limits.defaultRetryAfterMs;
      if (options.clock.now() + wait > deadline) {
        return result(
          makeConclusion(
            'deadline',
            `Retry-After ${wait}ms would pass the deadline during calibration`,
          ),
        );
      }
      await options.clock.sleep(wait);
      continue;
    }
    break;
  }

  if (!calibrationRecord) {
    return result(makeConclusion('transport_error', 'calibration produced no record'));
  }
  if (
    calibrationRecord.status === null ||
    calibrationRecord.status < 200 ||
    calibrationRecord.status >= 300
  ) {
    calibrationRecord.outcome = 'capacity_error';
    return result(
      makeConclusion(
        'capacity_error',
        `HTTP ${calibrationRecord.status} during calibration; capacity error, not a ceiling claim`,
      ),
    );
  }
  if (!calibrationRecord.usage) {
    calibrationRecord.outcome = 'missing_usage';
    return result(
      makeConclusion(
        'missing_usage',
        `HTTP ${calibrationRecord.status} without usage during calibration; stopped without inventing numbers`,
      ),
    );
  }
  consecutive429 = 0;
  calibration = {
    charsPerToken,
    promptTokens: calibrationRecord.usage.prompt_tokens,
    bodyChars: calibrationRecord.bodyChars,
  };

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    let successes = 0;
    let attempts = 0;
    while (successes < limits.successesPerLevel) {
      if (attempts >= limits.attemptsPerLevel) {
        return result(
          makeConclusion(
            'inconclusive',
            `level ${levelIndex} (${level.mode} target ${level.target}) exhausted ${attempts} attempts without ${limits.successesPerLevel} measured successes`,
            { level: levelIndex },
          ),
        );
      }
      attempts += 1;

      const body = buildBody(options.model, level, charsPerToken, callCounter++);
      const estimatedInput = Math.ceil(body.length / charsPerToken);
      const estimatedOutput =
        level.mode === 'input' ? level.companion : level.target;
      const call = await runOneCall(
        levelIndex,
        level,
        body,
        estimatedInput,
        estimatedOutput,
      );
      if (call.stop) {
        return result(makeConclusion(call.stop.kind, call.stop.note, { level: levelIndex }));
      }
      const record = call.record;
      if (!record) {
        return result(
          makeConclusion('transport_error', `level ${levelIndex} produced no record`, {
            level: levelIndex,
          }),
        );
      }

      if (record.status === 429) {
        record.outcome = 'rate_limited';
        belowLimit429 = true;
        consecutive429 += 1;
        if (consecutive429 >= limits.maxConsecutive429) {
          return result(
            makeConclusion(
              'repeatable_limit',
              `two consecutive 429s at level ${levelIndex} (${level.mode} target ${level.target}); ${successes} measured success(es) at this level`,
              { tested: true, level: levelIndex },
            ),
          );
        }
        const wait = record.retryAfterMs ?? limits.defaultRetryAfterMs;
        if (options.clock.now() + wait > deadline) {
          return result(
            makeConclusion(
              'deadline',
              `Retry-After ${wait}ms would pass the deadline at level ${levelIndex}`,
              { level: levelIndex },
            ),
          );
        }
        await options.clock.sleep(wait);
        continue;
      }

      consecutive429 = 0;

      if (record.status === null || record.status < 200 || record.status >= 300) {
        record.outcome = 'capacity_error';
        return result(
          makeConclusion(
            'capacity_error',
            `HTTP ${record.status} at level ${levelIndex}; capacity error, not a ceiling claim`,
            { level: levelIndex },
          ),
        );
      }

      if (!record.usage) {
        record.outcome = 'missing_usage';
        return result(
          makeConclusion(
            'missing_usage',
            `HTTP ${record.status} without usage at level ${levelIndex}; stopped without inventing numbers`,
            { level: levelIndex },
          ),
        );
      }

      const actualIn = record.uncachedIn as number;
      const actualOut = record.out as number;
      let success = false;
      let reason = '';
      if (level.mode === 'input') {
        if (actualIn < level.target) {
          reason = `actual uncached input ${actualIn} < target ${level.target}`;
        } else if (actualOut < level.companion) {
          reason = `actual output ${actualOut} < fixed ${level.companion}`;
        } else {
          success = true;
        }
      } else {
        if (actualOut < level.target) {
          reason = `actual output ${actualOut} < target ${level.target}`;
        } else if (actualIn > level.companion) {
          reason = `actual uncached input ${actualIn} > companion ${level.companion}`;
        } else {
          success = true;
        }
      }

      if (success) {
        record.outcome = 'success';
        successes += 1;
        maxSuccessfulInput = Math.max(maxSuccessfulInput, actualIn);
        maxSuccessfulOutput = Math.max(maxSuccessfulOutput, actualOut);
      } else {
        record.outcome = 'inconclusive';
        record.inconclusiveReason = reason;
      }
    }
  }

  return result(
    makeConclusion(
      'completed',
      belowLimit429
        ? 'all levels completed with measured actual-token successes; a 429 was seen but was not repeatable, so it is not a ceiling claim'
        : 'all levels completed with measured actual-token successes; no repeatable limit observed',
      { tested: true },
    ),
  );
}
