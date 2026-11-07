// Based on T3 Code (MIT): apps/server/src/usage/{usagePricing.ts, usageScanCache.ts, usageTranscriptReader.ts}
import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord, JobTokenUsage } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

import {
  calculateNotionalCost,
  loadDefaultRateTable,
  PRICE_TABLE_VERSION,
  type RateTable,
} from './provider-pricing.service.js';
import {
  buildScanCacheKey,
  getCachedScan,
  setCachedScan,
} from './usage-scan-cache.service.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type FileTail = {
  content: string;
  /** True when `content` is the whole file, not just its trailing bytes. */
  isComplete: boolean;
};

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  statSync: (filePath: string) => { size: number; mtimeMs: number };
  readFileSync: (filePath: string) => string;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  getClaudeContextWindow: () => string | undefined;
  getReportedClaudeContextWindow: (providerSessionId: string) => number | undefined;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
  rateTable?: RateTable;
  priceTableVersion?: string;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * Both JSONL usage readers below only need the newest usage row, which sits at
 * or near the end of the transcript. Reading just this much of the tail keeps
 * a session-open usage lookup O(1) in the transcript's size; the rare tail
 * with no usage row at all falls back to the full read.
 */
const TOKEN_USAGE_TAIL_BYTES = 4 * 1024 * 1024;

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  statSync: (filePath) => {
    const stats = fsSync.statSync(filePath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  },
  readFileSync: (filePath) => fsSync.readFileSync(filePath, 'utf8'),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileTail: async (filePath, maxBytes) => {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        return { content: await handle.readFile({ encoding: 'utf8' }), isComplete: true };
      }

      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, size - maxBytes);
      const content = buffer.toString('utf8');
      // The window almost never starts on a row boundary; dropping everything
      // up to the first newline discards the partial row (and any split
      // multi-byte character with it).
      const firstNewline = content.indexOf('\n');
      return {
        content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
        isComplete: false,
      };
    } finally {
      await handle.close();
    }
  },
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  getReportedClaudeContextWindow: (providerSessionId) => getReportedClaudeContextWindow(providerSessionId),
  isProviderSessionSuperseded: (providerSessionId, provider) =>
    sessionsDb.isProviderSessionSuperseded(providerSessionId, provider),
  rateTable: loadDefaultRateTable(),
  priceTableVersion: PRICE_TABLE_VERSION,
};

/**
 * Context windows the Claude SDK reported per provider session id.
 *
 * The SDK states the real window of the model that served a turn only in the
 * turn's `result.modelUsage[model].contextWindow`; the transcript records the
 * model id at most, and an id cannot tell a 200K from a 1M variant, nor what a
 * self-hosted model behind ANTHROPIC_BASE_URL allows. Remembering the reported
 * value lets the history-derived usage show the same window the live counter
 * did. It is process memory on purpose: after a restart the counter falls back
 * to CONTEXT_WINDOW until the session's next turn reports again.
 */
const reportedClaudeContextWindows = new Map<string, number>();

/** One number per session; the cap only bounds a long-lived server's memory. */
const MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS = 1000;

/**
 * Used by the Claude runtime provider to record the window the SDK reported for
 * a session's turn. Non-positive or non-numeric values are ignored so a build
 * that reports no window never overwrites one that did.
 */
export function rememberClaudeContextWindow(providerSessionId: string, contextWindow: number): void {
  if (!providerSessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  // Re-insert so the most recently reported sessions are the last evicted.
  reportedClaudeContextWindows.delete(providerSessionId);
  reportedClaudeContextWindows.set(providerSessionId, contextWindow);
  if (reportedClaudeContextWindows.size > MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS) {
    const oldestSessionId = reportedClaudeContextWindows.keys().next().value;
    if (oldestSessionId !== undefined) {
      reportedClaudeContextWindows.delete(oldestSessionId);
    }
  }
}

/**
 * Used by the Claude runtime provider (a resumed run starts from the window its
 * session last reported), the Claude history reader, and this service's usage
 * lookup. Returns undefined when no run has reported a window for the session.
 */
export function getReportedClaudeContextWindow(providerSessionId: string | null | undefined): number | undefined {
  return providerSessionId ? reportedClaudeContextWindows.get(providerSessionId) : undefined;
}

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

function findCodexSessionFileSync(
  directoryPath: string,
  providerSessionId: string,
): string | null {
  let entries: Dirent[];
  try {
    entries = fsSync.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = findCodexSessionFileSync(entryPath, providerSessionId);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

/** Newest `token_count` snapshot in the given JSONL text, or null when it has none. */
function findCodexTokenUsage(fileContent: string): TokenUsageResult | null {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      return {
        used: totalTokens,
        total: readUsageNumber(tokenInfo.model_context_window) || 200_000,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return null;
}

function emptyCodexTokenUsage(): TokenUsageResult {
  return {
    used: 0,
    total: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Latest context-window usage from a Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * Reads the newest assistant turn only: `input_tokens + cache_read +
 * cache_creation` is that one request's whole prompt, i.e. what the context
 * window currently holds. Summing turns would count the same cached prefix
 * once per turn.
 *
 * The total is the window the SDK reported for the session when there is one,
 * and the CONTEXT_WINDOW setting otherwise.
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  configuredContextWindow: string | undefined = process.env.CONTEXT_WINDOW,
  reportedContextWindow?: number,
): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A subagent's turns report the subagent's context window, not this
    // conversation's; reading one makes the counter drop to the subagent's
    // number and bounce back on the next main-thread turn.
    if (entry?.isSidechain === true) {
      continue;
    }

    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) {
      continue;
    }

    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const rowCacheReadTokens = readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const rowCacheCreationTokens = readUsageNumber(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens
        ?? usage.cacheCreationTokens,
    );
    const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
    const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

    // `<synthetic>` rows — interrupts, API errors, "No response requested" —
    // are written with an all-zero usage block rather than none at all. They
    // never carried a prompt, so treating one as the newest turn zeroed a
    // counter that a live event had just set correctly.
    if (rowInputTokens === 0 && rowOutputTokens === 0) {
      continue;
    }

    cacheReadTokens = rowCacheReadTokens;
    cacheCreationTokens = rowCacheCreationTokens;
    inputTokens = rowInputTokens;
    outputTokens = rowOutputTokens;
    break;
  }

  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  const configuredOrDefaultContextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
  const contextWindow = reportedContextWindow && reportedContextWindow > 0
    ? reportedContextWindow
    : configuredOrDefaultContextWindow;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function parseClaudeUsageEntries(fileContent: string): AnyRecord[] {
  const entries: AnyRecord[] = [];
  for (const line of fileContent.trim().split('\n')) {
    try {
      entries.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }
  return entries;
}

function claudeEntriesHaveUsage(entries: AnyRecord[]): boolean {
  return entries.some((entry) => entry?.type === 'assistant' && entry.message?.usage);
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

//----------------- TRANSCRIPT PARSERS FOR JOB TOKEN USAGE ------------

type ParsedTranscriptData = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  model: string | null;
};

/**
 * Parses a Claude JSONL transcript for cumulative token totals and active model.
 * Deduplicates multiple content chunks for the same message ID.
 */
export function parseClaudeTranscriptTokens(fileContent: string): ParsedTranscriptData {
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let detectedModel: string | null = null;
  const seenIds = new Set<string>();

  for (const line of fileContent.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AnyRecord;
      if (entry?.isSidechain === true) continue;
      const usage = entry?.type === 'assistant' ? entry.message?.usage : (entry?.usage ?? null);
      if (!usage) continue;

      const model = entry.message?.model ?? entry?.model;
      if (typeof model === 'string' && model && model !== '<synthetic>') {
        detectedModel = model;
      }
      if (model === '<synthetic>') continue;

      const messageId = entry.message?.id ?? entry.requestId;
      if (typeof messageId === 'string' && messageId) {
        if (seenIds.has(messageId)) continue;
        seenIds.add(messageId);
      }

      const input = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
      const cacheRead = readUsageNumber(
        usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
      );
      const cacheCreation = readUsageNumber(
        usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens,
      );
      const output = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

      if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) continue;

      uncachedInputTokens += input;
      cachedInputTokens += cacheRead;
      cacheCreationTokens += cacheCreation;
      outputTokens += output;
    } catch {}
  }

  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    model: detectedModel,
  };
}

/**
 * Parses a Codex rollout transcript for token totals and active model.
 * Codex records cumulative `token_count` event_msg snapshots.
 */
export function parseCodexTranscriptTokens(fileContent: string): ParsedTranscriptData {
  const lines = fileContent.trim().split('\n');
  let detectedModel: string | null = null;
  let latestUsage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
  } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AnyRecord;
      if (entry?.type === 'turn_context' && entry?.payload?.model) {
        detectedModel = String(entry.payload.model);
      }
      if (entry?.type === 'session_meta' && entry?.payload?.model) {
        detectedModel = String(entry.payload.model);
      }
      if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.info?.total_token_usage) {
        const u = entry.payload.info.total_token_usage as AnyRecord;
        latestUsage = {
          input_tokens: readUsageNumber(u.input_tokens),
          cached_input_tokens: readUsageNumber(u.cached_input_tokens ?? u.cached_tokens),
          cache_write_input_tokens: readUsageNumber(u.cache_write_input_tokens ?? u.cache_creation_input_tokens),
          output_tokens: readUsageNumber(u.output_tokens),
        };
      }
    } catch {}
  }

  if (latestUsage) {
    const cachedInputTokens = latestUsage.cached_input_tokens;
    const cacheCreationTokens = latestUsage.cache_write_input_tokens;
    const uncachedInputTokens = Math.max(0, latestUsage.input_tokens - cachedInputTokens);
    return {
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: latestUsage.output_tokens,
      model: detectedModel,
    };
  }

  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    model: detectedModel,
  };
}

/**
 * Parses a ZCode JSONL transcript for token totals and model.
 * Inspects `turn.completed` for token usage totals (ignoring interim `session.updated` events
 * which share turn IDs and report per-request tokens rather than turn totals).
 * Zcode input tokens already include cached tokens, so uncached input is input - cacheRead.
 */
export function parseZcodeTranscriptTokens(fileContent: string): ParsedTranscriptData {
  let detectedModel: string | null = null;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  const seenTurnIds = new Set<string>();

  for (const line of fileContent.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AnyRecord;
      const payload = event?.payload;
      if (event?.type === 'session.updated' && payload?.modelId) {
        detectedModel = String(payload.modelId);
      }
      if (event?.event === 'init' && event.init?.model) {
        detectedModel = String(event.init.model);
      }
      if (payload?.model) {
        detectedModel = String(payload.model);
      }

      // Usage is extracted exclusively from turn.completed events.
      // Interim session.updated events share the turn ID and report per-LLM-request fragments.
      if (event?.type === 'turn.completed') {
        const turnId = event?.turnId ?? payload?.turnId ?? event?.id;
        if (turnId && seenTurnIds.has(String(turnId))) continue;
        if (turnId) seenTurnIds.add(String(turnId));

        const usage = (payload?.usage && typeof payload.usage === 'object')
          ? payload.usage
          : (event?.usage && typeof event.usage === 'object')
            ? event.usage
            : (payload && typeof payload === 'object')
              ? payload
              : null;

        if (usage) {
          const rawInput = readUsageNumber(
            usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
          );
          const cacheRead = readUsageNumber(
            usage.cache_read_input_tokens ?? usage.cached_tokens ?? usage.cacheReadTokens,
          );
          const cacheWrite = readUsageNumber(
            usage.cache_creation_input_tokens ?? usage.cacheWriteTokens,
          );
          const output = readUsageNumber(
            usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens,
          );

          // Zcode input already includes cached tokens; uncached is rawInput - cacheRead.
          const uncached = Math.max(0, rawInput - cacheRead);

          uncachedInputTokens += uncached;
          cachedInputTokens += cacheRead;
          cacheCreationTokens += cacheWrite;
          outputTokens += output;
        }
      }
    } catch {}
  }

  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    model: detectedModel,
  };
}

/**
 * Parses an agy transcript for token totals and model.
 */
export function parseAgyTranscriptTokens(fileContent: string): ParsedTranscriptData {
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let detectedModel: string | null = 'gemini-3.8-flash-medium';

  for (const line of fileContent.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line) as AnyRecord;
      if (step.type === 'PLANNER_RESPONSE') {
        if (typeof step.model === 'string' && step.model) {
          detectedModel = step.model;
        }
        uncachedInputTokens += readUsageNumber(step.input_tokens ?? step.inputTokens);
        cachedInputTokens += readUsageNumber(step.cache_read_tokens ?? step.cached_tokens ?? step.cachedInputTokens);
        cacheCreationTokens += readUsageNumber(step.cache_creation_tokens ?? step.cacheCreationTokens);
        outputTokens += readUsageNumber(step.output_tokens ?? step.outputTokens);
      }
    } catch {}
  }

  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    model: detectedModel,
  };
}

function parseTranscriptData(content: string, provider?: string): ParsedTranscriptData {
  if (provider === 'codex') {
    return parseCodexTranscriptTokens(content);
  }
  if (provider === 'zcode') {
    return parseZcodeTranscriptTokens(content);
  }
  if (provider === 'agy') {
    return parseAgyTranscriptTokens(content);
  }
  if (provider === 'claude') {
    return parseClaudeTranscriptTokens(content);
  }

  // Auto-detection based on content signatures
  if (content.includes('"token_count"') || content.includes('"turn_context"')) {
    return parseCodexTranscriptTokens(content);
  }
  if (content.includes('"PLANNER_RESPONSE"')) {
    return parseAgyTranscriptTokens(content);
  }
  if (content.includes('"session.updated"') || content.includes('sess_native_zcode')) {
    return parseZcodeTranscriptTokens(content);
  }
  return parseClaudeTranscriptTokens(content);
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  function buildJobTokenUsage(
    parsed: ParsedTranscriptData,
    fallbackModel?: string | null,
    customRates?: RateTable,
  ): JobTokenUsage {
    const model = parsed.model ?? fallbackModel ?? null;
    const inputTokens = parsed.uncachedInputTokens + parsed.cachedInputTokens;
    const cacheTokens = parsed.cachedInputTokens + parsed.cacheCreationTokens;
    const totalTokens = inputTokens + parsed.outputTokens + parsed.cacheCreationTokens;

    const costResult = calculateNotionalCost(
      {
        uncachedInputTokens: parsed.uncachedInputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        outputTokens: parsed.outputTokens,
      },
      model,
      customRates ?? dependencies.rateTable,
    );

    return {
      inputTokens,
      outputTokens: parsed.outputTokens,
      cacheTokens,
      cacheReadTokens: parsed.cachedInputTokens,
      cacheCreationTokens: parsed.cacheCreationTokens,
      totalTokens,
      model,
      notionalCostUsd: costResult.notionalCostUsd,
      costSource: costResult.costSource,
      isNotional: true,
    };
  }

  return {
    /**
     * Scans a transcript file for token usage and notional cost, using the scan cache
     * keyed by transcript path, price table version, fallback model, custom rates, size, and mtime.
     */
    getTranscriptJobUsage(
      filePath: string,
      provider?: string,
      fallbackModel?: string | null,
      customRates?: RateTable,
    ): JobTokenUsage | null {
      if (!dependencies.fileExists(filePath)) {
        return null;
      }

      let stat: { size: number; mtimeMs: number };
      try {
        stat = dependencies.statSync(filePath);
      } catch {
        return null;
      }

      const priceTableVersion = dependencies.priceTableVersion ?? PRICE_TABLE_VERSION;
      const cacheKey = buildScanCacheKey(filePath, priceTableVersion, fallbackModel, customRates);
      const cached = getCachedScan(cacheKey, stat.size, stat.mtimeMs);
      if (cached) {
        return cached;
      }

      let content: string;
      try {
        content = dependencies.readFileSync(filePath);
      } catch {
        return null;
      }

      const parsed = parseTranscriptData(content, provider);
      const result = buildJobTokenUsage(parsed, fallbackModel, customRates);
      setCachedScan(cacheKey, stat.size, stat.mtimeMs, result);
      return result;
    },

    /**
     * Resolves the session transcript and returns the token usage and notional equivalent API cost.
     */
    getJobTokenUsage(
      sessionId: string,
      fallbackModel?: string | null,
      customRates?: RateTable,
    ): JobTokenUsage | null {
      const session = dependencies.getSessionById(sessionId);
      if (!session) return null;

      const provider = session.provider;
      const providerSessionId = session.provider_session_id || sessionId;

      if (provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) return null;
        let stat: { size: number; mtimeMs: number };
        try {
          stat = dependencies.statSync(databasePath);
        } catch {
          return null;
        }

        const target = `${databasePath}#${providerSessionId}`;
        const priceTableVersion = dependencies.priceTableVersion ?? PRICE_TABLE_VERSION;
        const cacheKey = buildScanCacheKey(target, priceTableVersion, fallbackModel, customRates);
        const cached = getCachedScan(cacheKey, stat.size, stat.mtimeMs);
        if (cached) return cached;

        try {
          const usage = readOpenCodeTokenUsage(databasePath, providerSessionId);
          const model = fallbackModel ?? session.model ?? 'zai-coding-plan/glm-5.3-flash';
          const costResult = calculateNotionalCost(
            {
              uncachedInputTokens: usage.inputTokens,
              cachedInputTokens: usage.cacheReadTokens ?? 0,
              cacheCreationTokens: usage.cacheCreationTokens ?? 0,
              outputTokens: usage.outputTokens,
            },
            model,
            customRates ?? dependencies.rateTable,
          );

          const result: JobTokenUsage = {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheTokens: (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheCreationTokens: usage.cacheCreationTokens ?? 0,
            totalTokens: usage.used,
            model,
            notionalCostUsd: costResult.notionalCostUsd,
            costSource: costResult.costSource,
            isNotional: true,
          };
          setCachedScan(cacheKey, stat.size, stat.mtimeMs, result);
          return result;
        } catch {
          return null;
        }
      }

      let sessionFilePath: string | null = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
        ? session.jsonl_path
        : null;

      if (!sessionFilePath) {
        if (provider === 'codex') {
          const codexDir = path.join(dependencies.getHomeDirectory(), '.codex', 'sessions');
          sessionFilePath = findCodexSessionFileSync(codexDir, providerSessionId);
        } else if (provider === 'zcode') {
          const zcodePath = path.join(dependencies.getHomeDirectory(), '.cloudcli', 'zcode', `${encodeURIComponent(sessionId)}.jsonl`);
          const providerZcodePath = path.join(dependencies.getHomeDirectory(), '.cloudcli', 'zcode', `${encodeURIComponent(providerSessionId)}.jsonl`);
          if (dependencies.fileExists(zcodePath)) {
            sessionFilePath = zcodePath;
          } else if (dependencies.fileExists(providerZcodePath)) {
            sessionFilePath = providerZcodePath;
          }
        } else if (provider === 'agy') {
          const agyPath = path.join(dependencies.getHomeDirectory(), '.cloudcli', 'agy', `${encodeURIComponent(sessionId)}.jsonl`);
          const nativeAgyPath = path.join(
            dependencies.getHomeDirectory(),
            '.gemini',
            'antigravity-cli',
            'brain',
            encodeURIComponent(providerSessionId),
            '.system_generated',
            'logs',
            'transcript_full.jsonl',
          );
          if (dependencies.fileExists(agyPath)) {
            sessionFilePath = agyPath;
          } else if (dependencies.fileExists(nativeAgyPath)) {
            sessionFilePath = nativeAgyPath;
          }
        } else if (provider === 'claude') {
          if (session.project_path) {
            const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
            const candidate = path.join(
              dependencies.getHomeDirectory(),
              '.claude',
              'projects',
              encodedProjectPath,
              `${providerSessionId}.jsonl`,
            );
            if (dependencies.fileExists(candidate)) sessionFilePath = candidate;
          }
        }
      }

      if (!sessionFilePath || !dependencies.fileExists(sessionFilePath)) {
        return null;
      }

      return this.getTranscriptJobUsage(sessionFilePath, provider, fallbackModel ?? session.model, customRates);
    },

    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The fallback covers rows whose provider id was never recorded, and for
      // a session discovered from disk the app id *is* its provider id. That
      // stops being true the moment an edit rewinds the conversation off a
      // thread: until the replacement run announces its own id, the fallback
      // would resolve the retired transcript and report the discarded
      // conversation's usage against an empty one.
      if (
        !session.provider_session_id
        && dependencies.isProviderSessionSuperseded(sessionId, session.provider)
      ) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
        };
      }

      const providerSessionId = session.provider_session_id || sessionId;

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
        const tailUsage = findCodexTokenUsage(tail.content);
        if (tailUsage || tail.isComplete) {
          return tailUsage ?? emptyCodexTokenUsage();
        }

        // A tail this large with no token_count row is pathological, but the
        // whole file is still authoritative when it happens.
        return findCodexTokenUsage(await dependencies.readTextFile(sessionFilePath))
          ?? emptyCodexTokenUsage();
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      if (!dependencies.fileExists(sessionFilePath)) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
      let entries = parseClaudeUsageEntries(tail.content);
      if (!claudeEntriesHaveUsage(entries) && !tail.isComplete) {
        entries = parseClaudeUsageEntries(await dependencies.readTextFile(sessionFilePath));
      }
      return summarizeClaudeTokenUsage(
        entries,
        dependencies.getClaudeContextWindow(),
        dependencies.getReportedClaudeContextWindow(providerSessionId),
      );
    },
  };
}

/**
 * Used by the provider routes and orchestrator jobs service to serve token usage and pricing from an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
