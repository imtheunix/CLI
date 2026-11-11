import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { Usage } from './pacer.js';
import { parseJsonUsage } from './usage.js';
import { RollingWindow } from './windows.js';

export interface ProbeModel {
  model: string;
  group: string;
}

export interface ProbeLevel {
  inputTokens: number;
  outputTokens: number;
}

export interface ProbeHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  latencyMs: number;
}

export interface PacerGroupUsage {
  window: { uncached_in: number; out: number };
  caps: { uncached_in: number; out: number };
  headroom?: number;
}

export interface PacerUsageSnapshot {
  now: string;
  groups: Record<string, PacerGroupUsage>;
}

export interface ProbeTransport {
  postChat(input: {
    model: string;
    prompt: string;
    maxOutputTokens: number;
  }): Promise<ProbeHttpResponse>;
  getUsage(): Promise<PacerUsageSnapshot>;
}

export interface ProbeOptions {
  models: ProbeModel[];
  levels: ProbeLevel[];
  clock: Clock;
  transport: ProbeTransport;
  deadlineMs: number;
  maxRequestInputTokens: number;
  maxRequestOutputTokens: number;
  successesPerLevel?: number;
  live?: boolean;
  logger?: Logger;
}

export type StopReason =
  | 'deadline'
  | 'request-cap'
  | 'second-429'
  | 'missing-usage'
  | 'live-load-guard'
  | 'transport-error'
  | 'completed';

export type AttemptClassification =
  | 'success'
  | 'cap-explanatory'
  | 'cap-not-explanatory'
  | 'error'
  | 'missing-usage';

export interface AttemptReport {
  step: number;
  model: string;
  group: string;
  level: ProbeLevel;
  status: number | null;
  latencyMs: number | null;
  retryAfterMs: number | null;
  usage: Usage | null;
  uncachedIn: number | null;
  out: number | null;
  liveWindow: { uncachedIn: number; out: number };
  probeWindow: { uncachedIn: number; out: number };
  combinedBefore: { uncachedIn: number; out: number };
  liveCaps: { uncachedIn: number; out: number };
  probeCaps: { uncachedIn: number; out: number };
  belowLiveCap: boolean | null;
  classification: AttemptClassification;
}

export interface LevelReport {
  level: ProbeLevel;
  attempts: AttemptReport[];
  successes: number;
  escalated: boolean;
}

export interface CeilingReport {
  proven: boolean;
  threshold: ProbeLevel | null;
  lastSuccessLevel: ProbeLevel | null;
  belowThresholdSuccess: boolean;
  reproducibleThreshold: boolean;
  reason: string;
}

export interface ModelReport {
  model: string;
  group: string;
  levels: LevelReport[];
  probeUsage: { uncachedIn: number; out: number };
  ceiling: CeilingReport;
}

export interface ProbeReport {
  version: 1;
  live: boolean;
  startedAt: string;
  finishedAt: string;
  deadlineMs: number;
  maxRequestInputTokens: number;
  maxRequestOutputTokens: number;
  models: ModelReport[];
  stop: { reason: StopReason; detail: string } | null;
  totals: {
    requests: number;
    successes: number;
    rateLimits: number;
    probeUsage: { uncachedIn: number; out: number };
  };
}

const WINDOW_MS = 60_000;
const DEFAULT_SUCCESSES_PER_LEVEL = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function parseRetryAfterMs(
  headers: Record<string, string | string[] | undefined>,
  now: number,
): number | null {
  const raw = headerValue(headers, 'retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

/**
 * A deterministic synthetic prompt of roughly `inputTokens` tokens (four characters per token).
 * The probe never trusts this estimate for accounting: only the usage Morph returns is recorded.
 */
export function syntheticPrompt(inputTokens: number): string {
  const unit = 'The quick brown fox jumps over the lazy dog. ';
  const target = Math.max(1, Math.ceil(inputTokens * 4));
  return unit.repeat(Math.ceil(target / unit.length)).slice(0, target);
}

function emptyCeiling(reason: string): CeilingReport {
  return {
    proven: false,
    threshold: null,
    lastSuccessLevel: null,
    belowThresholdSuccess: false,
    reproducibleThreshold: false,
    reason,
  };
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const clock = options.clock;
  const transport = options.transport;
  const successesPerLevel = options.successesPerLevel ?? DEFAULT_SUCCESSES_PER_LEVEL;
  const started = clock.now();
  const deadline = started + options.deadlineMs;
  const probeWindows = new Map<string, RollingWindow>();
  const models: ModelReport[] = [];
  const totals = {
    requests: 0,
    successes: 0,
    rateLimits: 0,
    probeUsage: { uncachedIn: 0, out: 0 },
  };
  let step = 0;
  let consecutive429 = 0;
  let stop: { reason: StopReason; detail: string } | null = null;

  outer: for (const model of options.models) {
    const modelReport: ModelReport = {
      model: model.model,
      group: model.group,
      levels: [],
      probeUsage: { uncachedIn: 0, out: 0 },
      ceiling: emptyCeiling('not reached'),
    };
    models.push(modelReport);

    let lastSuccessLevel: ProbeLevel | null = null;
    let ceilingCandidate: ProbeLevel | null = null;
    let modelStopped = false;
    let modelStopReason = '';

    for (const level of options.levels) {
      if (
        level.inputTokens > options.maxRequestInputTokens ||
        level.outputTokens > options.maxRequestOutputTokens
      ) {
        stop = {
          reason: 'request-cap',
          detail: `level ${level.inputTokens}/${level.outputTokens} exceeds the probe request cap`,
        };
        break outer;
      }

      const levelReport: LevelReport = {
        level,
        attempts: [],
        successes: 0,
        escalated: false,
      };
      modelReport.levels.push(levelReport);

      while (levelReport.successes < successesPerLevel) {
        if (clock.now() >= deadline) {
          stop = { reason: 'deadline', detail: 'probe deadline reached' };
          break outer;
        }

        let snapshot: PacerUsageSnapshot;
        try {
          snapshot = await transport.getUsage();
        } catch (error) {
          stop = {
            reason: 'missing-usage',
            detail: `pacer usage unreadable: ${errorMessage(error)}`,
          };
          break outer;
        }

        const group = snapshot?.groups?.[model.group];
        if (
          !group ||
          !isFiniteNumber(group.window?.uncached_in) ||
          !isFiniteNumber(group.window?.out) ||
          !isFiniteNumber(group.caps?.uncached_in) ||
          !isFiniteNumber(group.caps?.out)
        ) {
          stop = {
            reason: 'missing-usage',
            detail: `pacer usage missing for group ${model.group}`,
          };
          break outer;
        }

        const now = clock.now();
        const probeWindow = probeWindows.get(model.group) ?? new RollingWindow(WINDOW_MS);
        probeWindows.set(model.group, probeWindow);
        const probeTotals = probeWindow.totals(now);
        const combinedIn = group.window.uncached_in + probeTotals.uncachedIn + level.inputTokens;
        const combinedOut = group.window.out + probeTotals.out + level.outputTokens;

        if (
          combinedIn > options.maxRequestInputTokens ||
          combinedOut > options.maxRequestOutputTokens
        ) {
          stop = {
            reason: 'live-load-guard',
            detail:
              `planned combined load ${combinedIn}/${combinedOut} exceeds the probe cap ` +
              `${options.maxRequestInputTokens}/${options.maxRequestOutputTokens}`,
          };
          break outer;
        }

        step += 1;
        let response: ProbeHttpResponse;
        try {
          response = await transport.postChat({
            model: model.model,
            prompt: syntheticPrompt(level.inputTokens),
            maxOutputTokens: level.outputTokens,
          });
        } catch (error) {
          stop = {
            reason: 'transport-error',
            detail: `probe request failed: ${errorMessage(error)}`,
          };
          break outer;
        }

        const usage = parseJsonUsage(response.body);
        const retryAfterMs = parseRetryAfterMs(response.headers, clock.now());
        const belowLiveCap =
          combinedIn < group.caps.uncached_in && combinedOut < group.caps.out;
        const attempt: AttemptReport = {
          step,
          model: model.model,
          group: model.group,
          level,
          status: response.status,
          latencyMs: response.latencyMs,
          retryAfterMs,
          usage,
          uncachedIn: usage ? Math.max(0, usage.promptTokens - usage.cachedTokens) : null,
          out: usage ? usage.completionTokens : null,
          liveWindow: {
            uncachedIn: group.window.uncached_in,
            out: group.window.out,
          },
          probeWindow: {
            uncachedIn: probeTotals.uncachedIn,
            out: probeTotals.out,
          },
          combinedBefore: { uncachedIn: combinedIn, out: combinedOut },
          liveCaps: {
            uncachedIn: group.caps.uncached_in,
            out: group.caps.out,
          },
          probeCaps: {
            uncachedIn: options.maxRequestInputTokens,
            out: options.maxRequestOutputTokens,
          },
          belowLiveCap,
          classification: 'error',
        };
        levelReport.attempts.push(attempt);
        totals.requests += 1;

        if (response.status === 200) {
          if (!usage) {
            attempt.classification = 'missing-usage';
            stop = {
              reason: 'missing-usage',
              detail: '200 response carried no readable usage',
            };
            break outer;
          }
          const uncachedIn = Math.max(0, usage.promptTokens - usage.cachedTokens);
          probeWindow.add({
            t: clock.now(),
            uncachedIn,
            out: usage.completionTokens,
          });
          modelReport.probeUsage.uncachedIn += uncachedIn;
          modelReport.probeUsage.out += usage.completionTokens;
          totals.probeUsage.uncachedIn += uncachedIn;
          totals.probeUsage.out += usage.completionTokens;
          attempt.classification = 'success';
          levelReport.successes += 1;
          totals.successes += 1;
          consecutive429 = 0;
          lastSuccessLevel = level;
          continue;
        }

        if (response.status === 429) {
          totals.rateLimits += 1;
          consecutive429 += 1;
          attempt.classification = belowLiveCap
            ? 'cap-not-explanatory'
            : 'cap-explanatory';
          if (consecutive429 >= 2) {
            stop = {
              reason: 'second-429',
              detail: 'second consecutive 429; stopping the whole run',
            };
            break outer;
          }
          modelStopped = true;
          modelStopReason = belowLiveCap
            ? 'below-cap 429: cap not explanatory, not a proven ceiling'
            : 'cap-explanatory 429 at the next level';
          if (!belowLiveCap && lastSuccessLevel) ceilingCandidate = level;
          break;
        }

        attempt.classification = 'error';
        stop = {
          reason: 'transport-error',
          detail: `unexpected status ${response.status}`,
        };
        break outer;
      }

      if (modelStopped) break;
      if (levelReport.successes >= successesPerLevel) {
        levelReport.escalated = true;
        lastSuccessLevel = level;
      }
    }

    const belowThresholdSuccess = lastSuccessLevel !== null;
    const reproducibleThreshold = ceilingCandidate !== null && belowThresholdSuccess;
    if (reproducibleThreshold) {
      modelReport.ceiling = {
        proven: true,
        threshold: ceilingCandidate,
        lastSuccessLevel,
        belowThresholdSuccess,
        reproducibleThreshold,
        reason:
          'three successes at the previous level and a cap-explanatory 429 at the next level',
      };
    } else if (modelStopped) {
      modelReport.ceiling = {
        proven: false,
        threshold: null,
        lastSuccessLevel,
        belowThresholdSuccess,
        reproducibleThreshold: false,
        reason: modelStopReason,
      };
    } else {
      modelReport.ceiling = {
        proven: false,
        threshold: null,
        lastSuccessLevel,
        belowThresholdSuccess,
        reproducibleThreshold: false,
        reason: 'no 429 observed within the probed levels',
      };
    }
  }

  if (!stop) stop = { reason: 'completed', detail: 'all models and levels probed' };

  return {
    version: 1,
    live: options.live ?? false,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(clock.now()).toISOString(),
    deadlineMs: options.deadlineMs,
    maxRequestInputTokens: options.maxRequestInputTokens,
    maxRequestOutputTokens: options.maxRequestOutputTokens,
    models,
    stop,
    totals,
  };
}
