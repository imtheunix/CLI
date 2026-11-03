import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { ZcodeSessionSynchronizer } from '@/modules/providers/list/zcode/zcode-session-synchronizer.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type { IProviderRuntime, IProviderSessions, IProviderModels, IProviderAuth, IProviderMcp, IProviderSkills, IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord, NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError, createCompleteMessage, createNormalizedMessage, getZcodeDatabasePath, normalizeProviderTimestamp, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

const MODEL = 'GLM-5.3-Flash';
const EFFORTS = ['low', 'medium', 'high', 'max'];
const catalog: ProviderModelsDefinition = {
  DEFAULT: MODEL,
  OPTIONS: [
    { value: MODEL, label: 'GLM 5.3 Flash', effort: { values: EFFORTS.map((value) => ({ value })) } },
    { value: 'GLM-5.3', label: 'GLM 5.3', effort: { values: EFFORTS.map((value) => ({ value })) } },
  ],
};

function transcriptPath(sessionId: string): string {
  return path.join(os.homedir(), '.cloudcli', 'zcode', `${encodeURIComponent(sessionId)}.jsonl`);
}

function ensureZcodeModelConfig(model: string, effort?: string | null): void {
  const configFile = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
  try {
    let config: AnyRecord = {};
    if (existsSync(configFile)) {
      try {
        config = JSON.parse(readFileSync(configFile, 'utf8'));
      } catch {
        config = {};
      }
    }
    const innerConfig = readObjectRecord(config.config) ?? {};
    const defaultModelSelection = readObjectRecord(innerConfig.defaultModelSelection) ?? {};
    const currentOptions = readObjectRecord(defaultModelSelection.options) ?? {};
    const nextOptions = {
      ...currentOptions,
      reasoningLevel: effort && EFFORTS.includes(effort) ? effort : (currentOptions.reasoningLevel ?? 'max'),
    };
    const nextModelSelection = {
      providerId: defaultModelSelection.providerId ?? 'account:zai-individual-coding-plan',
      modelId: model,
      options: nextOptions,
    };
    const updated = {
      schemaVersion: config.schemaVersion ?? 1,
      ...config,
      config: {
        ...innerConfig,
        defaultModelSelection: nextModelSelection,
      },
    };
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Non-fatal if config path is unavailable
  }
}

function nativeZcodeHistory(targetProviderSessionId: string, sessionId: string): NormalizedMessage[] {
  const dbPath = getZcodeDatabasePath();
  if (!existsSync(dbPath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const messages = db.prepare(`
      SELECT m.id, m.data, m.time_created
      FROM message m
      WHERE m.session_id = ?
      ORDER BY m.sequence ASC, m.time_created ASC
    `).all(targetProviderSessionId) as Array<{ id: string; data: string; time_created: number }>;

    const parts = db.prepare(`
      SELECT p.id, p.message_id, p.data, p.time_created
      FROM part p
      WHERE p.session_id = ?
      ORDER BY p.sequence ASC, p.time_created ASC
    `).all(targetProviderSessionId) as Array<{ id: string; message_id: string; data: string; time_created: number }>;

    const partsByMsg = new Map<string, Array<{ id: string; data: string; time_created: number }>>();
    for (const p of parts) {
      const list = partsByMsg.get(p.message_id) ?? [];
      list.push(p);
      partsByMsg.set(p.message_id, list);
    }

    const result: NormalizedMessage[] = [];
    for (const msg of messages) {
      let msgData: AnyRecord = {};
      try { msgData = JSON.parse(msg.data); } catch { continue; }
      const role = msgData.role === 'assistant' ? 'assistant' : 'user';
      const msgParts = partsByMsg.get(msg.id) ?? [];
      const timestamp = new Date(msg.time_created).toISOString();
      const base = { provider: 'zcode' as const, sessionId, timestamp };

      for (const part of msgParts) {
        let partData: AnyRecord = {};
        try { partData = JSON.parse(part.data); } catch { continue; }
        if (partData.synthetic && !partData.text) continue;
        if (partData.type === 'text' && typeof partData.text === 'string' && partData.text.trim()) {
          result.push(createNormalizedMessage({
            ...base,
            id: `${part.id}`,
            kind: 'text',
            role,
            content: partData.text,
            model: role === 'assistant' ? MODEL : undefined,
          }));
        } else if (partData.type === 'tool' || partData.type === 'tool_use') {
          result.push(createNormalizedMessage({
            ...base,
            id: `${part.id}`,
            kind: 'tool_use',
            toolId: String(partData.id ?? part.id),
            toolName: String(partData.name ?? 'Tool'),
            toolInput: readObjectRecord(partData.input) ?? {},
          }));
        }
      }
    }
    return result;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function normalize(raw: unknown, sessionId: string | null): NormalizedMessage[] {
  const event = readObjectRecord(raw);
  if (!event) return [];
  const base = {
    provider: 'zcode' as const,
    sessionId,
    id: String(event.id ?? event.eventId ?? randomUUID()),
    timestamp: event.timestamp ? normalizeProviderTimestamp(event.timestamp) : new Date().toISOString(),
  };

  if (event.event === 'user') {
    return [createNormalizedMessage({ ...base, kind: 'text', role: 'user', content: String(event.content ?? '') })];
  }
  if (event.event === 'error') {
    return [createNormalizedMessage({ ...base, kind: 'error', content: String(event.content ?? event.error?.message ?? event.message ?? JSON.stringify(event.error ?? 'zcode turn failed')) })];
  }
  if (event.event === 'text' || event.event === 'agent_response') {
    return [createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: String(event.content ?? event.text_delta ?? ''), model: MODEL })];
  }
  if (event.event === 'stream_delta') {
    return [createNormalizedMessage({ ...base, kind: 'stream_delta', content: String(event.content ?? '') })];
  }

  if (event.type === 'turn.started') {
    const payload = readObjectRecord(event.payload);
    if (typeof payload?.input === 'string' && payload.input.trim()) {
      return [createNormalizedMessage({ ...base, kind: 'text', role: 'user', content: payload.input })];
    }
  }

  if (event.type === 'turn.failed') {
    const payload = readObjectRecord(event.payload);
    const err = readObjectRecord(payload?.error);
    const content = typeof err?.message === 'string'
      ? err.message
      : (typeof payload?.message === 'string' ? payload.message : 'zcode turn failed');
    return [createNormalizedMessage({ ...base, kind: 'error', content })];
  }

  const step = readObjectRecord(event.step_update);
  if (event.event === 'step_update' && step) {
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
      return [createNormalizedMessage({ ...base, kind: 'stream_delta', content: step.text_delta })];
    }
    if (step.step_type === 'tool') {
      const tool = readObjectRecord(step.tool_info) ?? {};
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolId: `${event.turnId ?? step.conversation_id ?? 'tool'}:${step.step_index ?? 0}`,
        toolName: String(step.tool_name ?? tool.name ?? 'Tool'),
        toolInput: readObjectRecord(tool.parameters) ?? {},
        ...((step.state === 'DONE' || step.state === 'ERROR') ? { toolResult: { content: String(tool.output ?? ''), isError: step.state === 'ERROR' || Boolean(tool.error) } } : {}),
      })];
    }
  }

  if (typeof event.text_delta === 'string') {
    return [createNormalizedMessage({ ...base, kind: 'stream_delta', content: event.text_delta })];
  }

  return [];
}

/** Providers registry: zcode non-interactive runs with durable streamed transcripts and conversation resumption. */
export class ZcodeProvider extends AbstractProvider {
  private readonly processes = new Map<string, ReturnType<typeof spawn>>();

  readonly models: IProviderModels = {
    getSupportedModels: async () => catalog,
    getCurrentActiveModel: async () => ({ model: MODEL }),
  };

  readonly auth: IProviderAuth = {
    getStatus: () => new Promise((resolve) => {
      // Probe the CLI binary and check credentials file existence without opening or printing credentials.
      execFile('zcode', ['version'], { timeout: 20_000 }, (error) => {
        const installed = (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT';
        const authenticated = installed && existsSync(path.join(os.homedir(), '.zcode', 'v2', 'credentials.json'));
        resolve({ provider: 'zcode', installed, authenticated, email: null, method: 'cli' });
      });
    }),
  };

  readonly sessions: IProviderSessions = {
    normalizeMessage: normalize,
    fetchHistory: async (sessionId, options = {}) => {
      const messages: NormalizedMessage[] = [];
      const appFile = transcriptPath(sessionId);
      const providerSessionId = options.providerSessionId ?? sessionId;
      const providerAppFile = transcriptPath(providerSessionId);

      const targetAppFile = existsSync(appFile) ? appFile : (existsSync(providerAppFile) ? providerAppFile : null);

      if (targetAppFile) {
        try {
          let textMessage: NormalizedMessage | null = null;
          const toolMessages = new Map<string, NormalizedMessage>();
          for (const line of readFileSync(targetAppFile, 'utf8').split('\n').filter(Boolean)) {
            let event: AnyRecord;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.event === 'init' || event.event === 'user' || event.type === 'turn.started') textMessage = null;
            for (const message of normalize(event, sessionId)) {
              if (message.kind === 'stream_delta') {
                if (!textMessage) {
                  textMessage = { ...message, kind: 'text', role: 'assistant', content: '' };
                  messages.push(textMessage);
                }
                textMessage.content = String(textMessage.content ?? '') + String(message.content ?? '');
              } else {
                textMessage = null;
                const toolMessage = message.toolId ? toolMessages.get(message.toolId) : null;
                if (toolMessage) Object.assign(toolMessage, message);
                else {
                  messages.push(message);
                  if (message.toolId) toolMessages.set(message.toolId, message);
                }
              }
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else {
        const nativeMessages = nativeZcodeHistory(providerSessionId, sessionId);
        if (nativeMessages.length > 0) {
          messages.push(...nativeMessages);
        } else if (providerSessionId !== sessionId) {
          messages.push(...nativeZcodeHistory(sessionId, sessionId));
        }
      }

      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;
      const { page, hasMore } = sliceTailPage(messages, limit, offset);
      return { messages: page, total: messages.length, hasMore, limit, offset };
    },
  };

  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ZcodeSessionSynchronizer();

  readonly mcp: IProviderMcp = {
    listServers: async () => ({ user: [], project: [], local: [] }),
    listServersForScope: async () => [],
    upsertServer: async () => { throw new AppError('Manage zcode MCP servers with zcode', { statusCode: 400 }); },
    removeServer: async () => { throw new AppError('Manage zcode MCP servers with zcode', { statusCode: 400 }); },
  };

  readonly skills: IProviderSkills = {
    listSkills: async () => [],
    addSkills: async () => { throw new AppError('Manage zcode skills with the zcode CLI', { statusCode: 400 }); },
    removeSkill: async () => { throw new AppError('Manage zcode skills with the zcode CLI', { statusCode: 400 }); },
  };

  readonly runtime: IProviderRuntime = {
    run: async (command, options, writer, context) => {
      const sessionId = String(options.sessionId);
      if (options.abortController?.signal.aborted) return;
      const conversation = context.resolveProviderSessionId(sessionId);
      const rawModel = await context.resolveResumeModel(sessionId, options.model);
      // GLM 5.3 Flash as its model: select explicitly, never full GLM-5.3 by default
      const model = rawModel && rawModel.toLowerCase().includes('glm-5.3') && !rawModel.toLowerCase().includes('flash')
        ? 'GLM-5.3'
        : MODEL;
      const effort = typeof options.effort === 'string' ? options.effort : 'medium';
      if (!EFFORTS.includes(effort)) throw new AppError(`Unsupported zcode effort: ${effort}`, { statusCode: 400 });

      ensureZcodeModelConfig(model, effort);

      const args = ['-p', command, '--output-format', 'stream-json'];
      if (conversation) args.push('--resume', conversation);
      if (options.permissionMode === 'plan') args.push('--mode', 'plan');
      else args.push('--mode', 'yolo');
      const cwd = options.cwd || options.projectPath || process.cwd();
      if (cwd) args.push('--cwd', cwd);

      const file = transcriptPath(sessionId);
      mkdirSync(path.dirname(file), { recursive: true });
      const turnId = randomUUID();
      const record = (event: AnyRecord) => {
        const row = { ...event, turnId, id: randomUUID(), timestamp: new Date().toISOString() };
        appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
        for (const message of normalize(row, sessionId)) writer.send(message);
      };

      appendFileSync(file, JSON.stringify({ event: 'user', content: command, id: randomUUID(), timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });

      await new Promise<void>((resolve) => {
        const child = spawn('zcode', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        this.processes.set(sessionId, child);
        let buffer = '';
        let failed = false;
        let settled = false;

        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          options.abortController?.signal.removeEventListener('abort', abort);
          if (this.processes.get(sessionId) === child) this.processes.delete(sessionId);
          writer.send(createCompleteMessage({ provider: 'zcode', sessionId, exitCode: failed ? 1 : code, aborted: Boolean(options.abortController?.signal.aborted) }));
          resolve();
        };

        const abort = () => { child.kill('SIGTERM'); };
        options.abortController?.signal.addEventListener('abort', abort, { once: true });
        if (options.abortController?.signal.aborted) abort();

        const line = (value: string) => {
          if (!value.trim()) return;
          let event: AnyRecord;
          try {
            event = JSON.parse(value);
          } catch {
            record({ event: 'error', content: value });
            failed = true;
            return;
          }
          const id = event.sessionId ?? event.session_id ?? event.conversation_id ?? event.init?.conversation_id ?? event.result?.conversation_id;
          if (typeof id === 'string') writer.setSessionId?.(id);
          if (event.event === 'error' || event.type === 'turn.failed') failed = true;
          if (event.event === 'result' && event.result?.status !== 'SUCCESS') {
            failed = true;
            record({ event: 'error', content: event.result?.error ?? event.result?.response ?? 'zcode turn failed' });
          }
          record(event);
        };

        child.stdout?.on('data', (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          lines.forEach(line);
        });

        child.stderr?.on('data', (data: Buffer) => {
          record({ event: 'error', content: data.toString() });
        });

        child.on('error', (error) => {
          failed = true;
          record({ event: 'error', content: error.message });
          finish(1);
        });

        child.on('close', (code) => {
          line(buffer);
          finish(code ?? 1);
        });
      });
    },
    abort: (sessionId) => this.processes.get(sessionId)?.kill('SIGTERM') ?? false,
  };

  constructor() {
    super('zcode');
  }
}
