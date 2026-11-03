import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { sessionsDb } from '@/modules/database/index.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessions,
  IProviderSessionSynchronizer,
  IProviderSkills,
} from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError, createNormalizedMessage, sliceTailPage } from '@/shared/utils.js';

export type LabsRequestRecord = {
  id: number;
  at: number;
  source: string;
  caller?: string | null;
  role?: string | null;
  instance?: string | null;
  node?: string | null;
  step?: string | null;
  model?: string | null;
  path?: string | null;
  status: number;
  seconds: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost?: number | null;
  error?: string | null;
  provider?: string | null;
  reasoning_tokens?: number | null;
  retries?: number | null;
  upstream?: string | null;
  cached_tokens?: number | null;
  cost_status?: string | null;
  fallback_reason?: string | null;
};

export type LabsProviderOptions = {
  baseUrl?: string;
  storageDir?: string;
  token?: string;
  tokenPath?: string;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
};

const DEFAULT_BASE_URL = 'http://localhost:18190';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const HISTORY_CAP_SECONDS = 30 * 24 * 60 * 60; // 30 days
const FIXED_VIRTUAL_PROJECT = 'LABS agents';

function readTokenFromFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      return content.length > 0 ? content : null;
    }
  } catch {
    // Return null if file cannot be read
  }
  return null;
}

/** Used by providerRegistry and tests to expose read-only LABS agent metadata sessions and history. */
export class LabsProvider extends AbstractProvider {
  private readonly baseUrl: string;
  private readonly storageDir: string;
  private readonly configuredToken?: string;
  private readonly tokenPath: string;
  private readonly pollIntervalMs: number;
  private readonly fetchFn: typeof fetch;

  private lastPollTime = 0;
  private newestAt: number | null = null;
  private newestId: number | null = null;
  private authErrorReported = false;

  readonly runtime: IProviderRuntime = {
    run: async () => {
      throw new AppError('LABS provider is read-only', { statusCode: 400 });
    },
    abort: () => false,
  };

  readonly models: IProviderModels = {
    getSupportedModels: async () => ({ DEFAULT: '', OPTIONS: [] }),
    getCurrentActiveModel: async () => ({ model: '' }),
  };

  readonly mcp: IProviderMcp = {
    listServers: async () => ({ user: [], project: [], local: [] }),
    listServersForScope: async () => [],
    upsertServer: async () => {
      throw new AppError('LABS provider does not support MCP', { statusCode: 400 });
    },
    removeServer: async () => {
      throw new AppError('LABS provider does not support MCP', { statusCode: 400 });
    },
  };

  readonly skills: IProviderSkills = {
    listSkills: async () => [],
    addSkills: async () => {
      throw new AppError('LABS provider does not support skills', { statusCode: 400 });
    },
    removeSkill: async () => {
      throw new AppError('LABS provider does not support skills', { statusCode: 400 });
    },
  };

  readonly auth: IProviderAuth = {
    getStatus: async () => {
      const token = this.resolveToken();
      return {
        provider: 'labs',
        installed: true,
        authenticated: Boolean(token),
        email: null,
        method: 'token',
      };
    },
  };

  readonly sessions: IProviderSessions = {
    normalizeMessage: () => [],

    fetchHistory: async (sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> => {
      const session = sessionsDb.getSessionById(sessionId);
      const targetSessionId = session?.provider_session_id ?? sessionId;
      const jsonlPath = session?.jsonl_path || this.getTranscriptPath(targetSessionId);

      const calls: LabsRequestRecord[] = [];
      if (fs.existsSync(jsonlPath)) {
        try {
          const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              calls.push(JSON.parse(line));
            } catch {
              continue;
            }
          }
        } catch {
          // If reading fails, proceed with empty calls
        }
      }

      // Sort chronological
      calls.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at));

      if (calls.length === 0) {
        return {
          messages: [],
          total: 0,
          hasMore: false,
          limit: options.limit ?? null,
          offset: options.offset ?? 0,
        };
      }

      // Compute totals
      let totalCalls = calls.length;
      let totalCost = 0;
      let promptTokens = 0;
      let cachedTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;

      for (const call of calls) {
        if (typeof call.cost === 'number') totalCost += call.cost;
        if (typeof call.prompt_tokens === 'number') promptTokens += call.prompt_tokens;
        if (typeof call.cached_tokens === 'number') cachedTokens += call.cached_tokens;
        if (typeof call.completion_tokens === 'number') completionTokens += call.completion_tokens;
        if (typeof call.reasoning_tokens === 'number') reasoningTokens += call.reasoning_tokens;
      }

      const totalTokens = promptTokens + completionTokens;
      const firstIsoTime = new Date(calls[0].at * 1000).toISOString();

      const totalsContent = [
        '### LABS Timeline Totals',
        `- **Calls:** ${totalCalls}`,
        `- **Tokens:** ${totalTokens.toLocaleString()} (prompt: ${promptTokens.toLocaleString()}, cached: ${cachedTokens.toLocaleString()}, completion: ${completionTokens.toLocaleString()}, reasoning: ${reasoningTokens.toLocaleString()})`,
        `- **Cost:** $${totalCost.toFixed(4)}`,
      ].join('\n');

      const messages: NormalizedMessage[] = [
        createNormalizedMessage({
          id: `${targetSessionId}:totals`,
          sessionId,
          provider: 'labs',
          kind: 'text',
          role: 'assistant',
          content: totalsContent,
          timestamp: firstIsoTime,
        }),
      ];

      for (const call of calls) {
        const callIsoTime = new Date(call.at * 1000).toISOString();
        const costStr = typeof call.cost === 'number' ? `$${call.cost.toFixed(4)}` : '$0.0000';
        const latencyStr = typeof call.seconds === 'number' ? `${call.seconds.toFixed(2)}s` : '0s';
        const nodeStep = [call.node, call.step].filter(Boolean).join(' / ') || '-';
        const retriesFallback = [
          typeof call.retries === 'number' ? `${call.retries} retries` : '0 retries',
          call.fallback_reason ? `fallback: ${call.fallback_reason}` : null,
        ]
          .filter(Boolean)
          .join(', ');

        const lines = [
          `**[${callIsoTime}]** \`${call.model || 'unknown-model'}\` — *${call.role || 'no-role'}*`,
          `- **Node / Step:** ${nodeStep}`,
          `- **Tokens:** prompt: ${call.prompt_tokens ?? 0} (cached: ${call.cached_tokens ?? 0}), completion: ${call.completion_tokens ?? 0} (reasoning: ${call.reasoning_tokens ?? 0})`,
          `- **Cost:** ${costStr} | **Status:** ${call.status} | **Latency:** ${latencyStr}`,
          `- **Retries / Fallback:** ${retriesFallback}`,
        ];

        if (call.error) {
          lines.push(`- **Error:** \`${call.error}\``);
        }

        messages.push(
          createNormalizedMessage({
            id: `${targetSessionId}:${call.id}`,
            sessionId,
            provider: 'labs',
            kind: 'text',
            role: 'assistant',
            model: call.model || undefined,
            content: lines.join('\n'),
            timestamp: callIsoTime,
          }),
        );
      }

      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;
      const { page, hasMore } = sliceTailPage(messages, limit, offset);

      return {
        messages: page,
        total: messages.length,
        hasMore,
        limit,
        offset,
      };
    },
  };

  readonly sessionSynchronizer: IProviderSessionSynchronizer = {
    synchronize: async (since?: Date): Promise<number> => {
      return this.syncRequests(since);
    },
    synchronizeFile: async (): Promise<string | null> => {
      return null;
    },
  };

  constructor(options: LabsProviderOptions = {}) {
    super('labs');
    this.baseUrl = (options.baseUrl ?? process.env.LABS_CONTROL_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.storageDir = options.storageDir ?? process.env.LABS_STORAGE_DIR ?? path.join(os.homedir(), '.cloudcli', 'labs');
    this.configuredToken = options.token ?? process.env.LABS_CONTROL_TOKEN ?? process.env.LABS_TOKEN;
    this.tokenPath = options.tokenPath ?? path.join(os.homedir(), '.config', 'cli', 'labs.token');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private resolveToken(): string | null {
    if (this.configuredToken && this.configuredToken.trim()) {
      return this.configuredToken.trim();
    }
    const token = readTokenFromFile(this.tokenPath);
    if (token) return token;

    // Check alternate path ~/.config/cli/labs-token
    const altPath = path.join(path.dirname(this.tokenPath), 'labs-token');
    return readTokenFromFile(altPath);
  }

  private getTranscriptPath(sessionId: string): string {
    return path.join(this.storageDir, `${encodeURIComponent(sessionId)}.jsonl`);
  }

  /**
   * Synchronizes proxy records from the control room into local sessions.
   */
  async syncRequests(sinceBoundary?: Date): Promise<number> {
    const now = Date.now();
    // Enforce poll interval unless sinceBoundary is provided or first run
    if (!sinceBoundary && this.lastPollTime > 0 && now - this.lastPollTime < this.pollIntervalMs) {
      return 0;
    }

    const token = this.resolveToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const thirtyDaysAgoSec = Math.floor(now / 1000) - HISTORY_CAP_SECONDS;
    const sinceSec = this.newestAt !== null ? this.newestAt : thirtyDaysAgoSec;

    const fetchedRows: LabsRequestRecord[] = [];
    let beforeCursor: number | null = null;
    const pageSize = 200;

    try {
      while (true) {
        const url = new URL(`${this.baseUrl}/api/llm/requests`);
        url.searchParams.set('limit', String(pageSize));
        if (sinceSec) {
          url.searchParams.set('since', String(sinceSec));
        }
        if (beforeCursor !== null) {
          url.searchParams.set('before', String(beforeCursor));
        }

        const res = await this.fetchFn(url.toString(), { headers });

        if (res.status === 401 || res.status === 403) {
          if (!this.authErrorReported) {
            console.warn('[Labs] LABS not authorised');
            this.authErrorReported = true;
          }
          return 0;
        }

        if (!res.ok) {
          return 0;
        }

        // Successfully authenticated
        this.authErrorReported = false;

        const data = (await res.json()) as LabsRequestRecord[];
        if (!Array.isArray(data) || data.length === 0) {
          break;
        }

        fetchedRows.push(...data);

        // When fewer items than requested were returned, we have reached the end
        if (data.length < pageSize) {
          break;
        }

        // Page back using the oldest record's id in the batch
        const oldestInBatch = data[data.length - 1];
        if (!oldestInBatch || oldestInBatch.id === beforeCursor) {
          break;
        }
        beforeCursor = oldestInBatch.id;
      }
    } catch {
      // Network or parsing errors do not crash synchronizer
      return 0;
    }

    this.lastPollTime = now;

    if (fetchedRows.length === 0) {
      return 0;
    }

    // Group rows by session
    const sessionsMap = new Map<string, {
      sessionId: string;
      title: string;
      records: LabsRequestRecord[];
    }>();

    for (const row of fetchedRows) {
      const source = String(row.source || 'unknown');
      const caller = row.caller ? String(row.caller).trim() : '';
      const instance = row.instance ? String(row.instance).trim() : null;
      const at = Number(row.at);
      const day = new Date(at * 1000).toISOString().slice(0, 10);

      const agentTitle = caller ? `${source}/${caller}` : source;
      let sessionId: string;
      let sessionTitle: string;

      if (instance) {
        sessionId = `labs:${source}:${caller}:${instance}`;
        sessionTitle = `${agentTitle} (${instance})`;
      } else {
        sessionId = `labs:${source}:${caller}:${day}`;
        sessionTitle = `${agentTitle} (${day})`;
      }

      let entry = sessionsMap.get(sessionId);
      if (!entry) {
        entry = { sessionId, title: sessionTitle, records: [] };
        sessionsMap.set(sessionId, entry);
      }
      entry.records.push(row);

      // Track newest cursor
      if (this.newestAt === null || at > this.newestAt) {
        this.newestAt = at;
      }
      if (this.newestId === null || row.id > this.newestId) {
        this.newestId = row.id;
      }
    }

    fs.mkdirSync(this.storageDir, { recursive: true });

    let updatedSessionCount = 0;

    for (const { sessionId, title, records } of sessionsMap.values()) {
      const filePath = this.getTranscriptPath(sessionId);
      const existingRecordsById = new Map<number, LabsRequestRecord>();

      if (fs.existsSync(filePath)) {
        try {
          const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const rec = JSON.parse(line) as LabsRequestRecord;
              existingRecordsById.set(rec.id, rec);
            } catch {
              continue;
            }
          }
        } catch {
          // Continue if file reading fails
        }
      }

      for (const rec of records) {
        existingRecordsById.set(rec.id, rec);
      }

      const allRecords = Array.from(existingRecordsById.values()).sort(
        (a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at),
      );

      const fileContent = allRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(filePath, fileContent, { mode: 0o600 });

      const minAt = allRecords[0].at;
      const maxAt = allRecords[allRecords.length - 1].at;
      const createdAt = new Date(minAt * 1000).toISOString();
      const updatedAt = new Date(maxAt * 1000).toISOString();

      sessionsDb.createSession(
        sessionId,
        'labs',
        FIXED_VIRTUAL_PROJECT,
        title,
        createdAt,
        updatedAt,
        filePath,
      );

      updatedSessionCount += 1;
    }

    return updatedSessionCount;
  }
}
