import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { readMergeStepHistory } from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';
import { providerTokenUsageService } from '@/modules/providers/index.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import type { HubService, HubStatus } from './hub.service.js';
import type { MorphUsage, MorphUsageService } from './morph-usage.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';

/** One goal block from the hub's goals.md. */
export type StatusGoal = {
  title: string;
  status: string;
  updated: string | null;
  now: string | null;
  next: string | null;
  jobs: string[];
  /** The person's ask, or null when the block says `none`. */
  needs: string | null;
};

/** A job as the status page shows it: the row plus the age or wait the view needs. */
export type StatusJob = {
  id: string;
  title: string;
  backend: OrchestratorBackend | null;
  model: string | null;
  state: string;
  mergeStep: string;
  /** Running/preparing: how long since the job was created. */
  ageMs: number | null;
  /** At review: how long since `tjob done` parked it. */
  waitingMs: number | null;
  /** In the CI/CD queue: the step it is on. */
  step: string | null;
  /** Merged/failed: when that happened (ISO 8601). */
  at: string | null;
  /** Why the person is needed, when this job is in `needsYou.jobs`. */
  reason: string | null;
};

/** What the person has to decide or do, gathered from goals and jobs. */
export type StatusNeedsYou = {
  goals: string[];
  jobs: Array<{ id: string; title: string; reason: string }>;
};

/** Morph's rolling usage, the backend slot loads and the quota waits. */
export type StatusCapacity = {
  morph: MorphUsage;
  loads: Record<OrchestratorBackend, number>;
  caps: Record<OrchestratorBackend, number>;
  /** Per backend, when a quota wait ends (ISO 8601); null when it is not waiting. */
  quota: Record<string, string | null>;
};

/** The hub session and when it was last woken. */
export type StatusHub = HubStatus & { lastWakeAt: string | null };

/** One efficiency window (rolling 1 h or 24 h). */
export type StatusEfficiencyWindow = {
  windowMs: number;
  deepseek: {
    /** Average and p90 of per-minute output against the DeepSeek output cap, over active minutes. */
    capUseAvg: number;
    capUseP90: number;
    activeMinutes: number;
    /** Average share of the morph slots in use over the window. */
    slotOccupancy: number;
  };
  kimi: {
    /** Billed output (output + reasoning) by role. */
    outputByRole: { hub: number; planner: number; jobs: number; compaction: number };
    /** reasoning / (output + reasoning), 0..1. */
    reasoningShare: number;
    /** cache.read / (uncached input + cache.read), 0..1. */
    cacheHit: number;
    /** Uncached input per hub assistant call. */
    uncachedInputPerHubCall: number;
  };
  flow: {
    leadTimeMedianMs: number | null;
    reviewWaitMedianMs: number | null;
    reviewWaitMaxMs: number | null;
    /** Share of merged jobs that needed a fix round (merge_attempts > 0). */
    fixRoundRate: number;
    mergedPerHour: number;
    tokensPerMergedJob: number;
  };
  waste: {
    compactionTokens: number;
    cancelledJobs: number;
    pacerWaitMs: number;
    retries429: number;
  };
};

/** Everything `tjob status`, the web Status view and STATUS.md render. */
export type StatusSnapshot = {
  at: string;
  needsYou: StatusNeedsYou;
  goals: StatusGoal[];
  jobs: {
    running: StatusJob[];
    review: StatusJob[];
    queue: StatusJob[];
    merged: StatusJob[];
    failed: StatusJob[];
  };
  capacity: StatusCapacity;
  hub: StatusHub;
  efficiency: { hour: StatusEfficiencyWindow; day: StatusEfficiencyWindow };
};

/** The status service's API, for the routes and the module's STATUS.md writer. */
export type StatusService = {
  snapshot: () => StatusSnapshot;
  markdown: () => string;
  /** Writes the markdown rendering to the cache file; returns the path. */
  writeMarkdown: () => string;
};

const BACKENDS: OrchestratorBackend[] = ['claude', 'codex', 'glm', 'agy', 'zcode', 'morph'];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
const DEFAULT_CACHE_MS = 30_000;
const QUEUE_STEPS = new Set(['queued', 'rebase', 'check', 'push', 'deploy']);

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone; Date.parse would read it as local time. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function median(values: number[]): number | null {
  return values.length === 0 ? null : percentile(values, 0.5);
}

/** The fields of a goal block's one-line body (`now: ... / next: ... / jobs: ... / needs the person: ...`). */
function parseGoalFields(body: string): Record<string, string> {
  const keys = ['now', 'next', 'jobs', 'needs the person'];
  const pattern = new RegExp(`(?:^|\\s/\\s)(${keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):\\s*`, 'g');
  const matches = [...body.matchAll(pattern)];
  const fields: Record<string, string> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? body.length : body.length;
    fields[match[1]] = body.slice(start, end).trim().replace(/\s*\/\s*$/, '').trim();
  }
  return fields;
}

/** `none` (also `none (…still requires explicit go)`) means the goal asks nothing of the person. */
function normalizeNeeds(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return !trimmed || /^none\b/i.test(trimmed) ? null : trimmed;
}

/**
 * Used by the status service and its tests: parses the hub's goals.md into goal blocks.
 * A block starts at `## Title | status: X | updated: Y`; the `# Done` section is not a goal.
 */
export function parseGoals(markdown: string): StatusGoal[] {
  const goals: StatusGoal[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (header === null) return;
    const match = /^##\s+(.*?)\s*\|\s*status:\s*(.*?)\s*\|\s*updated:\s*(.*)$/.exec(header);
    if (match) {
      const fields = parseGoalFields(body.join('\n'));
      goals.push({
        title: match[1].trim(),
        status: match[2].trim(),
        updated: match[3].trim() || null,
        now: fields.now || null,
        next: fields.next || null,
        jobs: (fields.jobs ?? '').split(/\s+/).filter(Boolean),
        needs: normalizeNeeds(fields['needs the person']),
      });
    }
    header = null;
    body = [];
  };
  for (const line of markdown.split('\n')) {
    if (/^#\s+Done\b/.test(line)) {
      flush();
      break;
    }
    if (line.startsWith('## ')) {
      flush();
      header = line;
      continue;
    }
    if (header !== null) body.push(line);
  }
  flush();
  return goals;
}

/** When a job merged: the last `merged` step event, else its update time. */
function mergedAt(job: OrchestratorJobRow): number | null {
  const merged = [...readMergeStepHistory(job)].reverse().find((event) => event.step === 'merged');
  return merged ? parseTimestamp(merged.at) : job.merge_step === 'merged' ? parseTimestamp(job.updated_at) : null;
}

/** When a job stopped holding its backend slot: the first CI/CD step, else its update time. */
function leftActiveAt(job: OrchestratorJobRow): number | null {
  const firstStep = readMergeStepHistory(job).find((event) => event.step !== 'none');
  return firstStep ? parseTimestamp(firstStep.at) : parseTimestamp(job.updated_at);
}

/** Why a job needs the person, or null when it does not. */
function jobNeedsPerson(job: OrchestratorJobRow): string | null {
  if (job.state === 'failed') return job.last_error?.split('\n')[0] ?? 'failed';
  if (job.merge_step === 'blocked') return job.last_error?.split('\n')[0] ?? 'merge blocked';
  try {
    const recovery = job.limit_recovery ? JSON.parse(job.limit_recovery) as { gaveUp?: boolean; reason?: string } : null;
    if (recovery?.gaveUp) return recovery.reason ?? 'recovery exhausted; waiting for the hub';
  } catch {
    // An unreadable recovery is not a reason to ask the person.
  }
  return null;
}

function toStatusJob(job: OrchestratorJobRow, nowMs: number, reason: string | null = null): StatusJob {
  const created = parseTimestamp(job.created_at);
  const updated = parseTimestamp(job.updated_at);
  const merged = mergedAt(job);
  return {
    id: job.id,
    title: job.title,
    backend: job.backend,
    model: job.model,
    state: job.state,
    mergeStep: job.merge_step,
    ageMs: job.state === 'preparing' || job.state === 'active' ? (created === null ? null : Math.max(0, nowMs - created)) : null,
    waitingMs: job.state === 'done' && job.merge_step === 'review' ? (updated === null ? null : Math.max(0, nowMs - updated)) : null,
    step: QUEUE_STEPS.has(job.merge_step) ? job.merge_step : null,
    at: job.state === 'failed' || job.merge_step === 'blocked'
      ? isoOrNull(job.updated_at)
      : merged === null ? null : new Date(merged).toISOString(),
    reason,
  };
}

/** One OpenCode assistant message, reduced to what the efficiency metrics need. */
type OpenCodeMessage = { ts: number; agent: string; model: string; input: number; output: number; reasoning: number; cacheRead: number };

/** One morph-pacer ledger line, reduced to the waste metrics. */
type LedgerEvent = { ts: number; waitMs: number; retries: number };

/** Reads Morph's assistant messages from OpenCode's database, read-only and tolerant of a lock. */
function readOpenCodeMessages(databasePath: string, sinceMs: number): OpenCodeMessage[] {
  if (!existsSync(databasePath)) return [];
  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  } catch {
    return [];
  }
  try {
    // The message index leads with session_id, so narrow to sessions touched in the window first.
    const rows = database.prepare(`
      SELECT time_created, data FROM message
      WHERE session_id IN (SELECT id FROM session WHERE time_updated >= ?)
        AND COALESCE(json_extract(data, '$.time.completed'), time_created) >= ?
    `).all(sinceMs, sinceMs) as Array<{ time_created: number; data: string }>;
    const messages: OpenCodeMessage[] = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as {
          role?: string;
          providerID?: string;
          modelID?: string;
          agent?: string;
          time?: { completed?: number };
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } };
        };
        if (data.role !== 'assistant' || data.providerID !== 'morph' || !data.tokens || !data.modelID) continue;
        const completed = typeof data.time?.completed === 'number' && Number.isFinite(data.time.completed) ? data.time.completed : row.time_created;
        messages.push({
          ts: completed,
          agent: data.agent ?? '',
          model: data.modelID,
          input: readNumber(data.tokens.input),
          output: readNumber(data.tokens.output),
          reasoning: readNumber(data.tokens.reasoning),
          cacheRead: readNumber(data.tokens.cache?.read),
        });
      } catch {
        // A malformed message row is not usage.
      }
    }
    return messages;
  } catch {
    return [];
  } finally {
    database.close();
  }
}

/** Reads the morph-pacer ledger's lines in the window; a half-written line is skipped. */
function readLedgerEvents(ledgerPath: string, sinceMs: number): LedgerEvent[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      events.push({ ts, waitMs: readNumber(row.wait_ms), retries: readNumber(row.retries) });
    } catch {
      // A half-written line (the pacer appends while we read): skip it, keep the rest.
    }
  }
  return events;
}

/** The last hub event's timestamp, the closest record of when the hub was last woken. */
function readLastHubEventAt(logPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((line) => line.trim());
  const last = lines.at(-1);
  if (!last) return null;
  const timestamp = last.split('\t')[0]?.trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
}

function isDeepSeek(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes('dsv41') || id.includes('deepseek');
}

function isKimi(model: string): boolean {
  return model.toLowerCase().includes('kimi');
}

/** The role a Kimi message belongs to: the hub, the planner, compaction, or a job's session. */
function kimiRole(agent: string): 'hub' | 'planner' | 'jobs' | 'compaction' {
  if (agent === 'morph-hub') return 'hub';
  if (agent === 'morph-planner') return 'planner';
  if (agent === 'compaction') return 'compaction';
  return 'jobs';
}

/** Average share of the morph slots in use over the window, from each morph job's active interval. */
function morphSlotOccupancy(jobs: OrchestratorJobRow[], nowMs: number, windowMs: number, cap: number): number {
  if (cap <= 0) return 0;
  const windowStart = nowMs - windowMs;
  const intervals = jobs
    .filter((job) => job.backend === 'morph')
    .map((job) => {
      const start = parseTimestamp(job.created_at);
      const end = job.state === 'preparing' || job.state === 'active' ? nowMs : leftActiveAt(job);
      return start === null || end === null ? null : { start, end };
    })
    .filter((interval): interval is { start: number; end: number } => interval !== null && interval.end > windowStart && interval.start < nowMs);
  if (intervals.length === 0) return 0;
  const minutes = Math.max(1, Math.round(windowMs / MINUTE_MS));
  let occupied = 0;
  for (let index = 0; index < minutes; index += 1) {
    const minuteStart = windowStart + index * MINUTE_MS;
    const minuteEnd = minuteStart + MINUTE_MS;
    const active = intervals.filter((interval) => interval.start < minuteEnd && interval.end > minuteStart).length;
    occupied += Math.min(active, cap) / cap;
  }
  return occupied / minutes;
}

/** Used by the status service and its tests: one efficiency window from the raw events and jobs. */
export function computeEfficiencyWindow(input: {
  messages: OpenCodeMessage[];
  ledger: LedgerEvent[];
  jobs: OrchestratorJobRow[];
  nowMs: number;
  windowMs: number;
  deepseekCapOut: number;
  morphCap: number;
  getJobTokens?: (sessionId: string, model: string | null) => number | null;
}): StatusEfficiencyWindow {
  const { messages, ledger, jobs, nowMs, windowMs, deepseekCapOut, morphCap } = input;
  const since = nowMs - windowMs;
  const inWindow = messages.filter((message) => message.ts >= since && message.ts <= nowMs);
  const ledgerInWindow = ledger.filter((event) => event.ts >= since && event.ts <= nowMs);

  const deepseek = inWindow.filter((message) => isDeepSeek(message.model));
  const perMinute = new Map<number, number>();
  for (const message of deepseek) {
    const minute = Math.floor(message.ts / MINUTE_MS) * MINUTE_MS;
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + message.output + message.reasoning);
  }
  const capUses = [...perMinute.values()].filter((out) => out > 0).map((out) => (deepseekCapOut > 0 ? out / deepseekCapOut : 0));

  const kimi = inWindow.filter((message) => isKimi(message.model));
  const outputByRole = { hub: 0, planner: 0, jobs: 0, compaction: 0 };
  let kimiOutput = 0;
  let kimiReasoning = 0;
  let kimiInput = 0;
  let kimiCacheRead = 0;
  let hubCalls = 0;
  let hubInput = 0;
  for (const message of kimi) {
    const billed = message.output + message.reasoning;
    outputByRole[kimiRole(message.agent)] += billed;
    kimiOutput += message.output;
    kimiReasoning += message.reasoning;
    kimiInput += message.input;
    kimiCacheRead += message.cacheRead;
    if (kimiRole(message.agent) === 'hub') {
      hubCalls += 1;
      hubInput += message.input;
    }
  }

  const merged = jobs.filter((job) => job.merge_step === 'merged' && (mergedAt(job) ?? 0) >= since);
  const leadTimes: number[] = [];
  const reviewWaits: number[] = [];
  let fixRounds = 0;
  let tokens = 0;
  for (const job of merged) {
    const created = parseTimestamp(job.created_at);
    const mergedTime = mergedAt(job);
    if (created !== null && mergedTime !== null) leadTimes.push(Math.max(0, mergedTime - created));
    const history = readMergeStepHistory(job);
    const review = history.find((event) => event.step === 'review');
    const queued = review ? history.slice(history.indexOf(review) + 1).find((event) => event.step === 'queued') : undefined;
    const reviewAt = review ? parseTimestamp(review.at) : null;
    const queuedAt = queued ? parseTimestamp(queued.at) : null;
    if (reviewAt !== null && queuedAt !== null) reviewWaits.push(Math.max(0, queuedAt - reviewAt));
    if (job.merge_attempts > 0) fixRounds += 1;
    // The jobs service's view already carries the session's usage; only a raw row needs the lookup.
    const viewUsage = (job as OrchestratorJobRow & { usage?: { totalTokens?: number } | null }).usage;
    if (typeof viewUsage?.totalTokens === 'number') tokens += viewUsage.totalTokens;
    else if (job.session_id && input.getJobTokens) tokens += input.getJobTokens(job.session_id, job.model) ?? 0;
  }

  const compactionTokens = inWindow
    .filter((message) => isKimi(message.model) && kimiRole(message.agent) === 'compaction')
    .reduce((sum, message) => sum + message.input + message.output + message.reasoning, 0);
  const cancelled = jobs.filter((job) => job.state === 'cancelled' && (parseTimestamp(job.updated_at) ?? 0) >= since).length;

  return {
    windowMs,
    deepseek: {
      capUseAvg: capUses.length === 0 ? 0 : capUses.reduce((sum, value) => sum + value, 0) / capUses.length,
      capUseP90: percentile(capUses, 0.9),
      activeMinutes: capUses.length,
      slotOccupancy: morphSlotOccupancy(jobs, nowMs, windowMs, morphCap),
    },
    kimi: {
      outputByRole,
      reasoningShare: kimiOutput + kimiReasoning === 0 ? 0 : kimiReasoning / (kimiOutput + kimiReasoning),
      cacheHit: kimiInput + kimiCacheRead === 0 ? 0 : kimiCacheRead / (kimiInput + kimiCacheRead),
      uncachedInputPerHubCall: hubCalls === 0 ? 0 : hubInput / hubCalls,
    },
    flow: {
      leadTimeMedianMs: median(leadTimes),
      reviewWaitMedianMs: median(reviewWaits),
      reviewWaitMaxMs: reviewWaits.length === 0 ? null : Math.max(...reviewWaits),
      fixRoundRate: merged.length === 0 ? 0 : fixRounds / merged.length,
      mergedPerHour: merged.length / (windowMs / HOUR_MS),
      tokensPerMergedJob: merged.length === 0 ? 0 : tokens / merged.length,
    },
    waste: {
      compactionTokens,
      cancelledJobs: cancelled,
      pacerWaitMs: ledgerInWindow.reduce((sum, event) => sum + event.waitMs, 0),
      retries429: ledgerInWindow.reduce((sum, event) => sum + event.retries, 0),
    },
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Used by `tjob status --md` and the server's STATUS.md writer: the snapshot as markdown. */
export function formatStatusMarkdown(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  const at = new Date(snapshot.at);
  lines.push(`# Status  (${at.toISOString().slice(0, 16).replace('T', ' ')})`, '');

  lines.push('## Needs you');
  const needs = [
    ...snapshot.needsYou.goals.map((need) => `- ${need}`),
    ...snapshot.needsYou.jobs.map((job) => `- ${job.id} ${job.title}: ${job.reason}`),
  ];
  lines.push(...(needs.length > 0 ? needs : ['- nothing']), '');

  lines.push('## Goals');
  for (const goal of snapshot.goals) {
    lines.push(`## ${goal.title}  | status: ${goal.status} | updated: ${goal.updated ?? '-'}`);
    const parts = [
      goal.now ? `now: ${goal.now}` : null,
      goal.next ? `next: ${goal.next}` : null,
      `jobs: ${goal.jobs.length > 0 ? goal.jobs.join(' ') : 'none'}`,
      `needs the person: ${goal.needs ?? 'none'}`,
    ].filter(Boolean);
    lines.push(parts.join(' / '), '');
  }

  const jobLine = (job: StatusJob): string => {
    const backend = job.backend ?? '-';
    const model = (job.model ?? '-').split('/').at(-1) ?? '-';
    const where = job.step ? `ci:${job.step}` : job.mergeStep !== 'none' ? `ci:${job.mergeStep}` : job.state;
    const extra = job.ageMs !== null ? ` (${formatDuration(job.ageMs)})` : job.waitingMs !== null ? ` (waiting ${formatDuration(job.waitingMs)})` : job.at ? ` (${job.at.slice(0, 16).replace('T', ' ')})` : '';
    return `${job.id}  ${backend}  ${model}  ${where}${extra}  ${job.title}`;
  };

  lines.push('## Jobs now', '```');
  const nowJobs = [...snapshot.jobs.running, ...snapshot.jobs.review, ...snapshot.jobs.queue];
  lines.push(...(nowJobs.length > 0 ? nowJobs.map(jobLine) : ['(none running)']));
  lines.push('```', '');

  lines.push('## Merged or failed in the last day', '```');
  const doneJobs = [...snapshot.jobs.merged, ...snapshot.jobs.failed];
  lines.push(...(doneJobs.length > 0 ? doneJobs.map(jobLine) : ['(none)']));
  lines.push('```', '');

  lines.push('## Capacity', '```');
  lines.push(BACKENDS.map((backend) => `${backend}: ${snapshot.capacity.loads[backend] ?? 0}/${snapshot.capacity.caps[backend] ?? 0}`).join('  '));
  const morph = snapshot.capacity.morph;
  lines.push(`morph: kimi out ${formatTokens(morph.groups.kimi.out)}/${formatTokens(morph.groups.kimi.caps.out)} in ${formatTokens(morph.groups.kimi.uncachedIn)}/${formatTokens(morph.groups.kimi.caps.uncachedIn)}`
    + ` | deepseek out ${formatTokens(morph.groups.deepseek.out)}/${formatTokens(morph.groups.deepseek.caps.out)} in ${formatTokens(morph.groups.deepseek.uncachedIn)}/${formatTokens(morph.groups.deepseek.caps.uncachedIn)}`);
  for (const [backend, until] of Object.entries(snapshot.capacity.quota)) {
    if (until) lines.push(`${backend}: quota-exhausted until ${until}`);
  }
  lines.push('```', '');

  lines.push('## Hub');
  const hub = snapshot.hub;
  if (!hub.sessionId) {
    lines.push('- no hub session configured');
  } else {
    lines.push(`- session: ${hub.sessionId}`);
    for (const key of ['provider', 'model', 'effort', 'agent'] as const) {
      if (hub[key]) lines.push(`- ${key}: ${hub[key]}`);
    }
    lines.push(`- last wake: ${hub.lastWakeAt ?? 'never'}`);
  }
  lines.push('');

  const efficiency = (label: string, window: StatusEfficiencyWindow): void => {
    lines.push(`## Efficiency (${label})`, '```');
    lines.push(`deepseek: cap use avg ${formatPercent(window.deepseek.capUseAvg)} p90 ${formatPercent(window.deepseek.capUseP90)} over ${window.deepseek.activeMinutes} active min | slots ${formatPercent(window.deepseek.slotOccupancy)}`);
    const roles = window.kimi.outputByRole;
    lines.push(`kimi: out hub ${formatTokens(roles.hub)} planner ${formatTokens(roles.planner)} jobs ${formatTokens(roles.jobs)} compaction ${formatTokens(roles.compaction)}`
      + ` | reasoning ${formatPercent(window.kimi.reasoningShare)} | cache hit ${formatPercent(window.kimi.cacheHit)} | uncached/hub call ${formatTokens(window.kimi.uncachedInputPerHubCall)}`);
    lines.push(`flow: lead ${formatDuration(window.flow.leadTimeMedianMs)} | review wait ${formatDuration(window.flow.reviewWaitMedianMs)} (max ${formatDuration(window.flow.reviewWaitMaxMs)})`
      + ` | fix rounds ${formatPercent(window.flow.fixRoundRate)} | merged/h ${window.flow.mergedPerHour.toFixed(2)} | tokens/merged ${formatTokens(window.flow.tokensPerMergedJob)}`);
    lines.push(`waste: compaction ${formatTokens(window.waste.compactionTokens)} | cancelled ${window.waste.cancelledJobs}`
      + ` | pacer wait ${formatDuration(window.waste.pacerWaitMs)} | 429 retries ${window.waste.retries429}`);
    lines.push('```', '');
  };
  efficiency('1h', snapshot.efficiency.hour);
  efficiency('24h', snapshot.efficiency.day);

  return lines.join('\n');
}

/**
 * Used by the orchestrator routes (`tjob status`, the web Status view) and the module's STATUS.md
 * writer. Reads goals.md, the job rows, Morph's meter, the hub and OpenCode's database, and caches
 * the snapshot for at most 30 s so a page refresh does not rescan the database.
 */
export function createStatusService(deps: {
  config: () => OrchestratorConfig;
  jobs: {
    list: () => OrchestratorJobRow[];
    loads: () => Record<OrchestratorBackend, number>;
    backendStatus: () => { glm: string | null; zcode: string | null };
  };
  morphUsage: MorphUsageService;
  hub: HubService;
  now?: () => Date;
  goalsPath?: string;
  databasePath?: string;
  ledgerPath?: string;
  hubEventsLogPath?: string;
  statusFilePath?: string;
  cacheMs?: number;
  getJobTokens?: (sessionId: string, model: string | null) => number | null;
}): StatusService {
  const now = deps.now ?? (() => new Date());
  const goalsPath = deps.goalsPath ?? path.join(os.homedir(), '.cache/tsge-hub/goals.md');
  const databasePath = deps.databasePath ?? getOpenCodeDatabasePath();
  const ledgerPath = deps.ledgerPath ?? path.join(os.homedir(), '.local/state/morph-pacer/ledger.jsonl');
  const hubEventsLogPath = deps.hubEventsLogPath ?? path.join(os.homedir(), '.cache/cli/hub-events.log');
  const statusFilePath = deps.statusFilePath ?? path.join(os.homedir(), '.cache/tsge-hub/STATUS.md');
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;
  const getJobTokens = deps.getJobTokens ?? ((sessionId: string, model: string | null) => providerTokenUsageService.getJobTokenUsage(sessionId, model)?.totalTokens ?? null);
  let cached: { at: number; snapshot: StatusSnapshot } | null = null;

  function readGoals(): StatusGoal[] {
    try {
      return parseGoals(readFileSync(goalsPath, 'utf8'));
    } catch {
      return [];
    }
  }

  function build(): StatusSnapshot {
    const at = now();
    const nowMs = at.getTime();
    const config = deps.config();
    const rows = deps.jobs.list();
    const goals = readGoals();

    const needsYou: StatusNeedsYou = {
      goals: goals.map((goal) => goal.needs).filter((need): need is string => need !== null),
      jobs: rows
        .map((job) => ({ job, reason: jobNeedsPerson(job) }))
        .filter((entry): entry is { job: OrchestratorJobRow; reason: string } => entry.reason !== null)
        .map(({ job, reason }) => ({ id: job.id, title: job.title, reason })),
    };

    const running = rows.filter((job) => job.state === 'preparing' || job.state === 'active').map((job) => toStatusJob(job, nowMs));
    const review = rows.filter((job) => job.state === 'done' && job.merge_step === 'review').map((job) => toStatusJob(job, nowMs));
    const queue = rows.filter((job) => QUEUE_STEPS.has(job.merge_step)).map((job) => toStatusJob(job, nowMs));
    const merged = rows
      .filter((job) => job.merge_step === 'merged' && (mergedAt(job) ?? 0) >= nowMs - DAY_MS)
      .map((job) => toStatusJob(job, nowMs))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    const failed = rows
      .filter((job) => (job.state === 'failed' || job.merge_step === 'blocked') && (parseTimestamp(job.updated_at) ?? 0) >= nowMs - DAY_MS)
      .map((job) => toStatusJob(job, nowMs, jobNeedsPerson(job)))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

    const quota: Record<string, string | null> = Object.fromEntries(BACKENDS.map((backend) => [backend, null]));
    const backendStatus = deps.jobs.backendStatus();
    if (backendStatus.glm) quota.glm = backendStatus.glm;
    if (backendStatus.zcode) quota.zcode = backendStatus.zcode;
    for (const job of rows) {
      if (!job.backend || !job.resume_at) continue;
      const current = quota[job.backend];
      if (!current || (parseTimestamp(job.resume_at) ?? Infinity) < (parseTimestamp(current) ?? Infinity)) quota[job.backend] = job.resume_at;
    }

    const messages = readOpenCodeMessages(databasePath, nowMs - DAY_MS);
    const ledger = readLedgerEvents(ledgerPath, nowMs - DAY_MS);
    const efficiencyInput = {
      messages,
      ledger,
      jobs: rows,
      nowMs,
      deepseekCapOut: config.morph.caps.deepseek.out,
      morphCap: config.backends.morph.cap,
      getJobTokens,
    };

    return {
      at: at.toISOString(),
      needsYou,
      goals,
      jobs: { running, review, queue, merged, failed },
      capacity: {
        morph: deps.morphUsage.usage(),
        loads: deps.jobs.loads(),
        caps: Object.fromEntries(BACKENDS.map((backend) => [backend, config.backends[backend].cap])) as Record<OrchestratorBackend, number>,
        quota,
      },
      hub: { ...deps.hub.status(), lastWakeAt: readLastHubEventAt(hubEventsLogPath) },
      efficiency: {
        hour: computeEfficiencyWindow({ ...efficiencyInput, windowMs: HOUR_MS }),
        day: computeEfficiencyWindow({ ...efficiencyInput, windowMs: DAY_MS }),
      },
    };
  }

  function snapshot(): StatusSnapshot {
    const at = now().getTime();
    if (cached && at - cached.at < cacheMs) return cached.snapshot;
    const built = build();
    cached = { at, snapshot: built };
    return built;
  }

  function markdown(): string {
    return formatStatusMarkdown(snapshot());
  }

  function writeMarkdown(): string {
    mkdirSync(path.dirname(statusFilePath), { recursive: true });
    writeFileSync(statusFilePath, `${markdown()}\n`, 'utf8');
    return statusFilePath;
  }

  return { snapshot, markdown, writeMarkdown };
}
