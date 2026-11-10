import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import type { MorphCaps, MorphModelGroup, OrchestratorConfig } from './orchestrator-config.service.js';

/** One request's usage, already reduced to the two numbers Morph Ultra caps. */
export type MorphUsageEvent = {
  /** End of the request, ms since the epoch. */
  ts: number;
  model: string;
  /** Input tokens that were not served from cache. */
  uncachedIn: number;
  /** Output tokens, reasoning included. */
  out: number;
};

/** One minute of a group's usage, oldest first in `MorphGroupUsage.minutes`. */
export type MorphMinuteUsage = { minute: string; uncachedIn: number; out: number };

/** A model group's rolling 60 s window, its caps, and the last 15 minutes per minute. */
export type MorphGroupUsage = {
  group: MorphModelGroup;
  uncachedIn: number;
  out: number;
  caps: { uncachedIn: number; out: number };
  minutes: MorphMinuteUsage[];
};

/** What `tjob meter` and the `tjob ls` line show: both groups, and where the numbers came from. */
export type MorphUsage = {
  source: 'ledger' | 'opencode' | 'none';
  at: string;
  groups: Record<MorphModelGroup, MorphGroupUsage>;
};

/** Used by the jobs service to admit a new morph job only while the DeepSeek output window has headroom. */
export type MorphUsageService = {
  usage: () => MorphUsage;
  admitted: () => boolean;
};

const WINDOW_MS = 60_000;
const MINUTE_MS = 60_000;
const MINUTES = 15;
/** The ledger is authoritative only while it has a line from this recent; otherwise OpenCode's DB is read. */
const LEDGER_FRESH_MS = 10 * 60_000;
const GROUPS: MorphModelGroup[] = ['kimi', 'deepseek'];

/** The group a model id belongs to; the two DeepSeek ids share one cap, Kimi K3.1 has its own. */
export function morphModelGroup(model: string): MorphModelGroup | null {
  const id = model.toLowerCase();
  if (id.includes('kimi')) return 'kimi';
  if (id.includes('dsv41') || id.includes('deepseek')) return 'deepseek';
  return null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Used by the meter and its tests: sums events into each group's rolling 60 s window and the last
 * 15 one-minute buckets. Events outside the 15 minutes, or for a model that is not Morph's, are ignored.
 */
export function computeMorphUsage(
  events: MorphUsageEvent[],
  caps: MorphCaps,
  now: Date,
  source: MorphUsage['source'],
): MorphUsage {
  const nowMs = now.getTime();
  const windowStart = nowMs - WINDOW_MS;
  const minutesStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS - (MINUTES - 1) * MINUTE_MS;
  const groups = Object.fromEntries(GROUPS.map((group) => [group, {
    group,
    uncachedIn: 0,
    out: 0,
    caps: { ...caps[group] },
    minutes: Array.from({ length: MINUTES }, (_, index) => ({
      minute: new Date(minutesStart + index * MINUTE_MS).toISOString(),
      uncachedIn: 0,
      out: 0,
    })),
  }])) as Record<MorphModelGroup, MorphGroupUsage>;

  for (const event of events) {
    const group = morphModelGroup(event.model);
    if (!group || event.ts > nowMs || event.ts < minutesStart) continue;
    const usage = groups[group];
    if (event.ts >= windowStart) {
      usage.uncachedIn += event.uncachedIn;
      usage.out += event.out;
    }
    const bucket = Math.floor((event.ts - minutesStart) / MINUTE_MS);
    if (bucket >= 0 && bucket < MINUTES) {
      usage.minutes[bucket].uncachedIn += event.uncachedIn;
      usage.minutes[bucket].out += event.out;
    }
  }

  return { source, at: now.toISOString(), groups };
}

/** Compact token counts for the CLI: 3.1k, 41k, 72.9k, 0.4M, 2.1M. */
export function formatCompactTokens(value: number): string {
  const amount = Math.max(0, value);
  const scaled = (divisor: number, suffix: string): string => {
    const n = amount / divisor;
    const rounded = n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
    return `${rounded}${suffix}`;
  };
  // The CLI's example line reads 0.4M for 400k, so the M form starts at 100k.
  if (amount >= 100_000) return scaled(1_000_000, 'M');
  if (amount >= 1_000) return scaled(1_000, 'k');
  return String(Math.round(amount));
}

/** Used by `tjob ls`: the one line under the loads, e.g. `morph: kimi out 3.1k/6.2k in 41k/72.9k | deepseek ...`. */
export function formatMorphLine(usage: MorphUsage): string {
  const part = (group: MorphModelGroup): string => {
    const entry = usage.groups[group];
    return `${group} out ${formatCompactTokens(entry.out)}/${formatCompactTokens(entry.caps.out)}`
      + ` in ${formatCompactTokens(entry.uncachedIn)}/${formatCompactTokens(entry.caps.uncachedIn)}`;
  };
  return `morph: ${part('kimi')} | ${part('deepseek')}`;
}

/** Used by `tjob meter`: the one-shot table, both groups and the last 15 minutes per minute. */
export function formatMorphTable(usage: MorphUsage): string {
  const lines = [
    `morph usage (${usage.source}, ${usage.at})`,
    `${'group'.padEnd(9)} ${'in 60s'.padStart(10)} ${'out 60s'.padStart(10)} ${'in cap'.padStart(12)} ${'out cap'.padStart(12)}`,
  ];
  for (const group of GROUPS) {
    const entry = usage.groups[group];
    lines.push(`${group.padEnd(9)} ${formatCompactTokens(entry.uncachedIn).padStart(10)} ${formatCompactTokens(entry.out).padStart(10)}`
      + ` ${formatCompactTokens(entry.caps.uncachedIn).padStart(12)} ${formatCompactTokens(entry.caps.out).padStart(12)}`);
  }
  lines.push('', 'last 15 min (per minute):');
  lines.push(`${'minute'.padEnd(8)} ${'kimi in'.padStart(10)} ${'kimi out'.padStart(10)} ${'deepseek in'.padStart(12)} ${'deepseek out'.padStart(12)}`);
  for (let index = 0; index < MINUTES; index += 1) {
    const kimi = usage.groups.kimi.minutes[index];
    const deepseek = usage.groups.deepseek.minutes[index];
    lines.push(`${kimi.minute.slice(11, 16).padEnd(8)} ${formatCompactTokens(kimi.uncachedIn).padStart(10)} ${formatCompactTokens(kimi.out).padStart(10)}`
      + ` ${formatCompactTokens(deepseek.uncachedIn).padStart(12)} ${formatCompactTokens(deepseek.out).padStart(12)}`);
  }
  return lines.join('\n');
}

/** Whether an input could be read: 'absent' is a fresh machine, 'unreadable' is a real failure. */
type ReadState = 'ok' | 'absent' | 'unreadable';
type ReadResult = { state: ReadState; events: MorphUsageEvent[] };

/** The morph-pacer ledger, one JSON line per request; `state` separates a missing file from a broken one. */
function readLedgerEvents(ledgerPath: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable', events: [] };
  }
  const events: MorphUsageEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts)) continue;
      events.push({
        ts,
        model: typeof row.model === 'string' ? row.model : '',
        uncachedIn: readNumber(row.uncached_in),
        // Reasoning is billed as output.
        out: readNumber(row.out) + readNumber(row.reasoning),
      });
    } catch {
      // A half-written line (the pacer appends while we read): skip it, keep the rest.
    }
  }
  return { state: 'ok', events };
}

/**
 * OpenCode's own message table, read-only and tolerant of a lock: assistant messages from the Morph
 * provider carry `tokens.input` (already uncached: OpenCode stores `nonCachedInputTokens`, with
 * `cache.read` and `cache.write` excluded), `tokens.output` and `tokens.reasoning`. The event time is
 * the message's completion time (`time.completed`), falling back to its creation time. `state` is
 * 'absent' when the database file does not exist (a fresh machine) and 'unreadable' when it exists
 * but cannot be opened or queried.
 */
function readOpenCodeEvents(databasePath: string, now: Date): ReadResult {
  if (!existsSync(databasePath)) return { state: 'absent', events: [] };
  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  } catch {
    return { state: 'unreadable', events: [] };
  }
  try {
    const since = now.getTime() - MINUTES * MINUTE_MS;
    // The message index leads with session_id, so narrow to sessions touched in the window first;
    // a bare time filter would scan the whole (multi-GB) message table. A long stream is counted in
    // the window it actually loaded, so filter and timestamp by completion time when it is present.
    const rows = database.prepare(`
      SELECT time_created, data FROM message
      WHERE session_id IN (SELECT id FROM session WHERE time_updated >= ?)
        AND COALESCE(json_extract(data, '$.time.completed'), time_created) >= ?
    `).all(since, since) as Array<{ time_created: number; data: string }>;
    const events: MorphUsageEvent[] = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as {
          role?: string;
          providerID?: string;
          modelID?: string;
          time?: { completed?: number };
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        };
        if (data.role !== 'assistant' || data.providerID !== 'morph' || !data.tokens || !data.modelID) continue;
        const completed = typeof data.time?.completed === 'number' && Number.isFinite(data.time.completed)
          ? data.time.completed
          : row.time_created;
        events.push({
          ts: completed,
          model: data.modelID,
          uncachedIn: readNumber(data.tokens.input),
          out: readNumber(data.tokens.output) + readNumber(data.tokens.reasoning),
        });
      } catch {
        // A malformed message row is not usage.
      }
    }
    return { state: 'ok', events };
  } catch {
    return { state: 'unreadable', events: [] };
  } finally {
    database.close();
  }
}

/**
 * Used by the orchestrator routes (`tjob meter`, the `tjob ls` line) and the jobs service's morph
 * admission. Reads the morph-pacer ledger while it is fresh, else OpenCode's database.
 */
export function createMorphUsageService(deps: {
  config: () => OrchestratorConfig;
  now?: () => Date;
  ledgerPath?: string;
  databasePath?: string;
}): MorphUsageService {
  const now = deps.now ?? (() => new Date());
  const ledgerPath = deps.ledgerPath ?? path.join(os.homedir(), '.local/state/morph-pacer/ledger.jsonl');
  const databasePath = deps.databasePath ?? getOpenCodeDatabasePath();

  function read(): { usage: MorphUsage; inputsAbsent: boolean } {
    const at = now();
    const caps = deps.config().morph.caps;
    const ledger = readLedgerEvents(ledgerPath);
    if (ledger.state === 'ok' && ledger.events.some((event) => event.ts >= at.getTime() - LEDGER_FRESH_MS)) {
      return { usage: computeMorphUsage(ledger.events, caps, at, 'ledger'), inputsAbsent: false };
    }
    const opencode = readOpenCodeEvents(databasePath, at);
    if (opencode.state === 'ok') {
      return { usage: computeMorphUsage(opencode.events, caps, at, 'opencode'), inputsAbsent: false };
    }
    // No readable input. Only a genuinely fresh machine (both files absent) may admit deliberately;
    // a stale ledger or an unreadable database means headroom is unknown, so admission fails closed.
    const inputsAbsent = ledger.state === 'absent' && opencode.state === 'absent';
    return { usage: computeMorphUsage([], caps, at, 'none'), inputsAbsent };
  }

  function usage(): MorphUsage {
    return read().usage;
  }

  function admitted(): boolean {
    const { usage: current, inputsAbsent } = read();
    if (current.source === 'none') return inputsAbsent;
    const cap = current.groups.deepseek.caps.out;
    return current.groups.deepseek.out < deps.config().morph.admitBelow * cap;
  }

  return { usage, admitted };
}
