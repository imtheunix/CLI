import type { Clock } from './clock.js';
import type { Caps } from './config.js';
import type { GroupUsageSnapshot, Usage } from './pacer.js';
import { parseJsonUsage } from './usage.js';
import { RollingWindow } from './windows.js';

export interface ProbeRequest {
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface ProbeHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface PacerUsageSnapshot {
  now: string;
  groups: Record<string, GroupUsageSnapshot>;
}

export interface ProbeTransport {
  postChatCompletion(request: ProbeRequest): Promise<ProbeHttpResponse>;
  getPacerUsage(): Promise<PacerUsageSnapshot>;
}

export interface ProbeBounds {
  /** Total wall-clock bound for the invocation. */
  deadlineMs: number;
  /** Cumulative calls, failures included. */
  maxCalls: number;
  maxInputSteps: number;
  maxOutputSteps: number;
  /** Finite uncached-input token budget for this invocation. */
  inputBudget: number;
  /** Finite output token budget for this invocation. */
  outputBudget: number;
  /** Fraction of the live cap that may already be in use before the probe refuses to start. */
  headroom: number;
  /** Bound for the live pacer usage read. */
  liveTimeoutMs: number;
  /** Bound for one direct provider request. */
  requestTimeoutMs: number;
}

export const DEFAULT_PROBE_BOUNDS: ProbeBounds = {
  deadlineMs: 20 * 60_000,
  maxCalls: 160,
  maxInputSteps: 60,
  maxOutputSteps: 30,
  inputBudget: 2_000_000,
  outputBudget: 60_000,
  headroom: 0.95,
  liveTimeoutMs: 2_000,
  requestTimeoutMs: 120_000,
};

export type ProbeJudgment = 'ceiling' | 'cap-not-explanatory' | 'inconclusive';

export type ProbeRecordJudgment =
  | 'success'
  | 'cap-not-explanatory'
  | 'at-or-above-cap'
  | 'error';

export interface ProbeWindow {
  uncachedIn: number;
  out: number;
}

export interface ProbeRecord {
  step: number;
  model: string;
  status: number;
  latencyMs: number;
  retryAfterMs: number | null;
  requested: { inputTarget: number; outputTarget: number };
  usage: Usage | null;
  windows: {
    live: ProbeWindow;
    probe: ProbeWindow;
    combined: ProbeWindow;
  };
  caps: Caps;
  judgment: ProbeRecordJudgment;
}

export interface ProbeStop {
  reason: string;
  guard: boolean;
}

export interface ProbeReport {
  protocol: 'morph-rate-probe/1';
  model: string;
  group: string;
  startedAt: string;
  finishedAt: string;
  bounds: ProbeBounds;
  caps: Caps;
  stop: ProbeStop;
  judgment: ProbeJudgment;
  calls: number;
  inputSteps: number;
  outputSteps: number;
  inputUsed: number;
  outputUsed: number;
  records: ProbeRecord[];
}

export interface ProbeOptions {
  model: string;
  bounds: ProbeBounds;
  clock: Clock;
  transport: ProbeTransport;
  initialInputTarget?: number;
  initialOutputTarget?: number;
  promptFactory?: (targetTokens: number) => string;
}

const DEFAULT_INPUT_TARGET = 256;
const DEFAULT_OUTPUT_TARGET = 32;
const ESCALATION_FACTOR = 1.5;

export function syntheticPrompt(targetTokens: number): string {
  const sentences = Math.max(1, Math.ceil(Math.max(1, targetTokens) / 10));
  return 'The quick brown fox jumps over the lazy dog. '.repeat(sentences);
}

export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number,
): number | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function findGroup(
  snapshot: PacerUsageSnapshot,
  model: string,
): { key: string; group: GroupUsageSnapshot } | null {
  for (const [key, group] of Object.entries(snapshot.groups ?? {})) {
    if (Array.isArray(group.models) && group.models.includes(model)) {
      return { key, group };
    }
  }
  return null;
}

function validCaps(caps: Caps | undefined): caps is Caps {
  return (
    !!caps &&
    Number.isFinite(caps.uncachedIn) &&
    caps.uncachedIn > 0 &&
    Number.isFinite(caps.out) &&
    caps.out > 0
  );
}

function usableUsage(usage: Usage | null): usage is Usage {
  return (
    !!usage &&
    Number.isFinite(usage.promptTokens) &&
    usage.promptTokens > 0 &&
    Number.isFinite(usage.completionTokens) &&
    usage.completionTokens >= 0
  );
}

function windowOf(totals: { uncachedIn: number; out: number }): ProbeWindow {
  return { uncachedIn: totals.uncachedIn, out: totals.out };
}

function classify(
  records: ProbeRecord[],
  stop: ProbeStop,
  belowThresholdSuccess: boolean,
): ProbeJudgment {
  if (stop.guard) return 'inconclusive';

  const belowCap = records.some((record) => record.judgment === 'cap-not-explanatory');
  if (belowCap) return 'cap-not-explanatory';

  const atCap = records.filter((record) => record.judgment === 'at-or-above-cap');
  if (atCap.length === 0) return 'inconclusive';

  const levels = new Map<string, number>();
  for (const record of atCap) {
    const key = `${record.requested.inputTarget}:${record.requested.outputTarget}`;
    levels.set(key, (levels.get(key) ?? 0) + 1);
  }
  const repeatable = [...levels.values()].some((count) => count >= 2);
  if (repeatable && belowThresholdSuccess) return 'ceiling';
  return 'inconclusive';
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const { model, bounds, clock, transport } = options;
  const promptFactory = options.promptFactory ?? syntheticPrompt;
  const started = clock.now();
  const deadline = started + bounds.deadlineMs;
  const probeWindow = new RollingWindow(60_000);

  let inputTarget = options.initialInputTarget ?? DEFAULT_INPUT_TARGET;
  let outputTarget = options.initialOutputTarget ?? DEFAULT_OUTPUT_TARGET;
  let inputSteps = 0;
  let outputSteps = 0;
  let inputUsed = 0;
  let outputUsed = 0;
  let calls = 0;
  let successesAtLevel = 0;
  let consecutive429 = 0;
  let belowThresholdSuccess = false;
  let levelPrompts: number[] = [];
  let levelCompletions: number[] = [];
  let groupKey = '';
  let caps: Caps = { uncachedIn: 0, out: 0 };
  const records: ProbeRecord[] = [];
  let stop: ProbeStop = { reason: 'completed', guard: false };

  const finish = (reason: string, guard: boolean): void => {
    stop = { reason, guard };
  };

  for (;;) {
    if (clock.now() >= deadline) {
      finish('deadline', true);
      break;
    }
    if (calls >= bounds.maxCalls) {
      finish('call-cap', true);
      break;
    }
    if (inputSteps >= bounds.maxInputSteps) {
      finish('input-step-cap', true);
      break;
    }
    if (outputSteps >= bounds.maxOutputSteps) {
      finish('output-step-cap', true);
      break;
    }
    if (inputUsed >= bounds.inputBudget) {
      finish('input-budget', true);
      break;
    }
    if (outputUsed >= bounds.outputBudget) {
      finish('output-budget', true);
      break;
    }

    let snapshot: PacerUsageSnapshot;
    try {
      snapshot = await transport.getPacerUsage();
    } catch {
      finish('live-load', true);
      break;
    }

    const found = findGroup(snapshot, model);
    if (!found || !validCaps(found.group.caps)) {
      finish('live-load', true);
      break;
    }
    groupKey = found.key;
    caps = found.group.caps;

    const live = windowOf(found.group.window);
    if (
      live.uncachedIn >= caps.uncachedIn * bounds.headroom ||
      live.out >= caps.out * bounds.headroom
    ) {
      finish('live-load', true);
      break;
    }

    const probe = windowOf(probeWindow.totals(clock.now()));
    const combined = {
      uncachedIn: live.uncachedIn + probe.uncachedIn,
      out: live.out + probe.out,
    };

    const request: ProbeRequest = {
      model,
      prompt: promptFactory(inputTarget),
      maxTokens: outputTarget,
    };

    const requestStarted = clock.now();
    let response: ProbeHttpResponse;
    try {
      response = await transport.postChatCompletion(request);
    } catch {
      finish('transport-error', true);
      break;
    }
    const latencyMs = clock.now() - requestStarted;
    calls += 1;

    const retryAfterMs = parseRetryAfter(
      headerValue(response.headers['retry-after']),
      clock.now(),
    );
    const usage = parseJsonUsage(response.body);
    const record: ProbeRecord = {
      step: calls,
      model,
      status: response.status,
      latencyMs,
      retryAfterMs,
      requested: { inputTarget, outputTarget },
      usage: usableUsage(usage) ? usage : null,
      windows: { live, probe, combined },
      caps,
      judgment: 'error',
    };
    records.push(record);

    if (response.status === 429) {
      consecutive429 += 1;
      const belowCap =
        combined.uncachedIn < caps.uncachedIn && combined.out < caps.out;
      record.judgment = belowCap ? 'cap-not-explanatory' : 'at-or-above-cap';

      if (consecutive429 >= 2) {
        finish('second-429', false);
        break;
      }

      const waitMs = retryAfterMs ?? 0;
      if (clock.now() + waitMs >= deadline) {
        finish('deadline', true);
        break;
      }
      if (waitMs > 0) await clock.sleep(waitMs);
      continue;
    }

    consecutive429 = 0;

    if (response.status < 200 || response.status >= 300) {
      finish(`http-${response.status}`, true);
      break;
    }

    if (!usableUsage(usage)) {
      finish('missing-usage', true);
      break;
    }

    const uncachedIn = Math.max(0, usage.promptTokens - usage.cachedTokens);
    probeWindow.add({ t: clock.now(), uncachedIn, out: usage.completionTokens });
    inputUsed += uncachedIn;
    outputUsed += usage.completionTokens;
    record.judgment = 'success';
    belowThresholdSuccess = true;
    successesAtLevel += 1;
    levelPrompts.push(usage.promptTokens);
    levelCompletions.push(usage.completionTokens);

    if (successesAtLevel >= 3) {
      const observedPrompt = Math.max(...levelPrompts);
      const observedCompletion = Math.max(...levelCompletions);
      inputTarget = Math.max(
        inputTarget + 1,
        Math.ceil(observedPrompt * ESCALATION_FACTOR),
      );
      outputTarget = Math.max(
        outputTarget + 1,
        Math.ceil(observedCompletion * ESCALATION_FACTOR),
      );
      inputSteps += 1;
      outputSteps += 1;
      successesAtLevel = 0;
      levelPrompts = [];
      levelCompletions = [];
    }
  }

  const finished = clock.now();
  return {
    protocol: 'morph-rate-probe/1',
    model,
    group: groupKey,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    bounds,
    caps,
    stop,
    judgment: classify(records, stop, belowThresholdSuccess),
    calls,
    inputSteps,
    outputSteps,
    inputUsed,
    outputUsed,
    records,
  };
}
