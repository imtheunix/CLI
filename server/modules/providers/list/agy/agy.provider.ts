import { spawn, execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type { IProviderRuntime, IProviderSessions, IProviderModels, IProviderAuth, IProviderMcp, IProviderSkills } from '@/shared/interfaces.js';
import type { AnyRecord, NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError, createCompleteMessage, createNormalizedMessage, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

// Verified with `agy models` on 2026-11-03. Effort is also passed explicitly
// so resumed conversations receive the effort chosen for the current turn.
const MODEL = 'gemini-3.8-flash-medium';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const catalog: ProviderModelsDefinition = {
  DEFAULT: MODEL,
  OPTIONS: [{ value: MODEL, label: 'Gemini 3.8 Flash (Medium)', effort: { values: EFFORTS.map((value) => ({ value })) } }],
};

function transcriptPath(sessionId: string): string {
  // App session ids are opaque; never allow them to escape the transcript folder.
  return path.join(os.homedir(), '.cloudcli', 'agy', `${encodeURIComponent(sessionId)}.jsonl`);
}

function normalize(raw: unknown, sessionId: string | null): NormalizedMessage[] {
  const event = readObjectRecord(raw);
  if (!event) return [];
  const base = { provider: 'agy' as const, sessionId, id: event.id, timestamp: event.timestamp };
  if (event.event === 'user') return [createNormalizedMessage({ ...base, kind: 'text', role: 'user', content: event.content })];
  if (event.event === 'error') return [createNormalizedMessage({ ...base, kind: 'error', content: event.content ?? event.error?.message ?? event.message ?? JSON.stringify(event.error ?? 'agy turn failed') })];
  const step = readObjectRecord(event.step_update);
  if (event.event === 'step_update' && step) {
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
      return [createNormalizedMessage({ ...base, kind: 'stream_delta', content: step.text_delta })];
    }
    if (step.step_type === 'agent_response') return [];
    if (step.step_type === 'tool') {
      const tool = readObjectRecord(step.tool_info) ?? {};
      return [createNormalizedMessage({
        ...base, kind: 'tool_use', toolId: `${event.turnId ?? step.conversation_id}:${step.step_index}`,
        toolName: step.tool_name ?? tool.name ?? 'Tool', toolInput: tool.parameters ?? {},
        ...((step.state === 'DONE' || step.state === 'ERROR') ? { toolResult: { content: String(tool.output ?? ''), isError: step.state === 'ERROR' || Boolean(tool.error) } } : {}),
      })];
    }
    if (step.step_type !== 'user_input') {
      // Retain tool/reasoning steps for transcript inspection even when agy's
      // protocol introduces a step shape this adapter does not yet recognize.
      return [createNormalizedMessage({ ...base, kind: 'status', text: step.step_type, content: JSON.stringify(step) })];
    }
  }
  return [];
}

/** Providers registry: agy print-mode jobs with durable streamed transcripts and conversation resumption. */
export class AgyProvider extends AbstractProvider {
  private readonly processes = new Map<string, ReturnType<typeof spawn>>();

  readonly models: IProviderModels = {
    getSupportedModels: async () => catalog,
    getCurrentActiveModel: async () => ({ model: MODEL }),
  };

  readonly auth: IProviderAuth = {
    getStatus: () => new Promise((resolve) => {
      // Probe the CLI itself; never open credential files. `models` requires
      // the user's existing agy login and reports failure when unavailable.
      execFile('agy', ['models'], { timeout: 20_000 }, (error) => {
        resolve({ provider: 'agy', installed: (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT', authenticated: !error, email: null, method: 'cli' });
      });
    }),
  };

  readonly sessions: IProviderSessions = {
    normalizeMessage: normalize,
    fetchHistory: async (sessionId, options = {}) => {
      const messages: NormalizedMessage[] = [];
      try {
        let textMessage: NormalizedMessage | null = null;
        const toolMessages = new Map<string, NormalizedMessage>();
        for (const line of readFileSync(transcriptPath(sessionId), 'utf8').split('\n').filter(Boolean)) {
          let event: AnyRecord;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.event === 'init' || event.event === 'user') textMessage = null;
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
      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;
      const { page, hasMore } = sliceTailPage(messages, limit, offset);
      return { messages: page, total: messages.length, hasMore, limit, offset };
    },
  };

  // These sessions are created in-app and recorded by this runtime. They do
  // not need a scan of agy's unrelated native conversation storage.
  readonly sessionSynchronizer = { synchronize: async () => 0, synchronizeFile: async () => null };

  // Configuration writes are deliberately unavailable: agy owns its login,
  // MCP and skill configuration, which jobs inherit from the installed CLI.
  readonly mcp: IProviderMcp = {
    listServers: async () => ({ user: [], project: [], local: [] }),
    listServersForScope: async () => [],
    upsertServer: async () => { throw new AppError('Manage agy MCP servers with agy mcp', { statusCode: 400 }); },
    removeServer: async () => { throw new AppError('Manage agy MCP servers with agy mcp', { statusCode: 400 }); },
  };
  readonly skills: IProviderSkills = {
    listSkills: async () => [],
    addSkills: async () => { throw new AppError('Manage agy skills with the agy CLI', { statusCode: 400 }); },
    removeSkill: async () => { throw new AppError('Manage agy skills with the agy CLI', { statusCode: 400 }); },
  };

  readonly runtime: IProviderRuntime = {
    run: async (command, options, writer, context) => {
      const sessionId = String(options.sessionId);
      if (options.abortController?.signal.aborted) return;
      const conversation = context.resolveProviderSessionId(sessionId);
      const model = await context.resolveResumeModel(sessionId, options.model) ?? MODEL;
      const args = ['-p', command, '--model', model, '--output-format', 'stream-json'];
      if (conversation) args.push('--conversation', conversation);
      const effort = typeof options.effort === 'string' ? options.effort : 'medium';
      if (!EFFORTS.includes(effort)) throw new AppError(`Unsupported agy effort: ${effort}`, { statusCode: 400 });
      args.push('--effort', effort);
      if (options.permissionMode === 'bypassPermissions' || options.skipPermissions) args.push('--dangerously-skip-permissions');
      else if (options.permissionMode === 'plan') args.push('--mode', 'plan');
      else args.push('--mode', 'auto');
      const file = transcriptPath(sessionId);
      mkdirSync(path.dirname(file), { recursive: true });
      const turnId = randomUUID();
      const record = (event: AnyRecord) => {
        const row = { ...event, turnId, id: randomUUID(), timestamp: new Date().toISOString() };
        appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
        for (const message of normalize(row, sessionId)) writer.send(message);
      };
      // The detached-turn runner echoes the prompt live; this is its durable copy.
      appendFileSync(file, JSON.stringify({ event: 'user', content: command, id: randomUUID(), timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });
      await new Promise<void>((resolve) => {
        const child = spawn('agy', args, { cwd: options.cwd || options.projectPath || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        this.processes.set(sessionId, child);
        let buffer = '';
        let failed = false;
        let settled = false;
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          options.abortController?.signal.removeEventListener('abort', abort);
          if (this.processes.get(sessionId) === child) this.processes.delete(sessionId);
          writer.send(createCompleteMessage({ provider: 'agy', sessionId, exitCode: failed ? 1 : code, aborted: Boolean(options.abortController?.signal.aborted) }));
          resolve();
        };
        const abort = () => { child.kill('SIGTERM'); };
        options.abortController?.signal.addEventListener('abort', abort, { once: true });
        if (options.abortController?.signal.aborted) abort();
        const line = (value: string) => {
          if (!value.trim()) return;
          let event: AnyRecord;
          try { event = JSON.parse(value); } catch { record({ event: 'error', content: value }); failed = true; return; }
          const id = event.conversation_id ?? event.init?.conversation_id ?? event.result?.conversation_id;
          if (typeof id === 'string') writer.setSessionId?.(id);
          if (event.event === 'error') failed = true;
          if (event.event === 'result' && event.result?.status !== 'SUCCESS') {
            failed = true;
            record({ event: 'error', content: event.result?.error ?? event.result?.response ?? 'agy turn failed' });
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
        child.on('error', (error) => { failed = true; record({ event: 'error', content: error.message }); finish(1); });
        child.on('close', (code) => { line(buffer); finish(code ?? 1); });
      });
    },
    abort: (sessionId) => this.processes.get(sessionId)?.kill('SIGTERM') ?? false,
  };

  constructor() { super('agy'); }
}
