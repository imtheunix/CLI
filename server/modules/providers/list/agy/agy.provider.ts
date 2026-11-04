import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { abortTurn, spawnDetachedTurn } from '@/modules/detached-turns/index.js';
import { AgySessionSynchronizer } from '@/modules/providers/list/agy/agy-session-synchronizer.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type { IProviderRuntime, IProviderSessions, IProviderModels, IProviderAuth, IProviderMcp, IProviderSkills, IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord, NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError, createCompleteMessage, createNormalizedMessage, normalizeProviderTimestamp, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

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

function nativeTranscriptPath(providerSessionId: string): string {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    encodeURIComponent(providerSessionId),
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  );
}

type PendingToolCall = {
  toolId: string;
  toolMsg: NormalizedMessage;
};

/**
 * Normalizes agy native transcript_full.jsonl lines into the unified NormalizedMessage structure.
 * Used by AgyProvider.fetchHistory and unit tests.
 */
export function normalizeAgyTranscript(
  linesOrContent: string[] | string,
  sessionId: string,
  providerSessionId?: string,
): NormalizedMessage[] {
  const lines = Array.isArray(linesOrContent)
    ? linesOrContent
    : linesOrContent.split('\n');
  const targetProviderSessionId = providerSessionId ?? sessionId;
  const messages: NormalizedMessage[] = [];
  const pendingToolCalls: PendingToolCall[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let step: AnyRecord;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const type = typeof step.type === 'string' ? step.type : '';
    const stepIndex = step.step_index !== undefined ? String(step.step_index) : String(messages.length);
    const timestamp = normalizeProviderTimestamp(step.created_at);
    const base = {
      provider: 'agy' as const,
      sessionId,
      timestamp,
    };

    if (type === 'USER_INPUT') {
      messages.push(createNormalizedMessage({
        ...base,
        id: `${targetProviderSessionId}:${stepIndex}:user`,
        kind: 'text',
        role: 'user',
        content: typeof step.content === 'string' ? step.content : '',
      }));
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        messages.push(createNormalizedMessage({
          ...base,
          id: `${targetProviderSessionId}:${stepIndex}:thinking`,
          kind: 'thinking',
          content: step.thinking,
        }));
      }
      if (typeof step.content === 'string' && step.content.trim()) {
        messages.push(createNormalizedMessage({
          ...base,
          id: `${targetProviderSessionId}:${stepIndex}:text`,
          kind: 'text',
          role: 'assistant',
          content: step.content,
          model: MODEL,
        }));
      }
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((call: unknown, idx: number) => {
          const callRecord = readObjectRecord(call) ?? {};
          const toolName = typeof callRecord.name === 'string' ? callRecord.name : 'Tool';
          const toolInput = callRecord.args ?? {};
          const toolId = `${targetProviderSessionId}:${stepIndex}:${idx}`;
          const toolMsg = createNormalizedMessage({
            ...base,
            id: `${targetProviderSessionId}:${stepIndex}:tool:${idx}`,
            kind: 'tool_use',
            toolName,
            toolInput,
            toolId,
          });
          messages.push(toolMsg);
          pendingToolCalls.push({ toolId, toolMsg });
        });
      }
      continue;
    }

    if (type === 'GENERIC') {
      const pending = pendingToolCalls.shift();
      const isError = step.status === 'ERROR' || Boolean(step.error);
      const resultContent = typeof step.content === 'string'
        ? step.content
        : (typeof step.error === 'string' ? step.error : '');

      if (pending) {
        pending.toolMsg.toolResult = {
          content: resultContent,
          isError,
        };
        messages.push(createNormalizedMessage({
          ...base,
          id: `${targetProviderSessionId}:${stepIndex}:result`,
          kind: 'tool_result',
          toolId: pending.toolId,
          content: resultContent,
          isError,
        }));
      } else if (isError) {
        messages.push(createNormalizedMessage({
          ...base,
          id: `${targetProviderSessionId}:${stepIndex}:error`,
          kind: 'error',
          content: resultContent || 'Generic step error',
        }));
      } else if (resultContent.trim()) {
        messages.push(createNormalizedMessage({
          ...base,
          id: `${targetProviderSessionId}:${stepIndex}:status`,
          kind: 'status',
          text: 'generic',
          content: resultContent,
        }));
      }
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      const errorText = typeof step.error === 'string'
        ? step.error
        : (typeof step.content === 'string' ? step.content : 'Error');
      messages.push(createNormalizedMessage({
        ...base,
        id: `${targetProviderSessionId}:${stepIndex}:error`,
        kind: 'error',
        content: errorText,
      }));
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      messages.push(createNormalizedMessage({
        ...base,
        id: `${targetProviderSessionId}:${stepIndex}:system`,
        kind: 'status',
        text: 'system',
        role: 'assistant',
        content: typeof step.content === 'string' ? step.content : '',
      }));
      continue;
    }

    if (type === 'CHECKPOINT') {
      messages.push(createNormalizedMessage({
        ...base,
        id: `${targetProviderSessionId}:${stepIndex}:checkpoint`,
        kind: 'status',
        role: 'assistant',
        content: typeof step.content === 'string' ? step.content : 'Compaction checkpoint',
        compact: { phase: 'completed' },
        isCompactSummary: true,
      }));
      continue;
    }

    if (step.content || step.error) {
      messages.push(createNormalizedMessage({
        ...base,
        id: `${targetProviderSessionId}:${stepIndex}:status`,
        kind: 'status',
        text: type || 'step',
        content: typeof step.content === 'string' ? step.content : JSON.stringify(step),
      }));
    }
  }

  return messages;
}

function normalize(raw: unknown, sessionId: string | null): NormalizedMessage[] {
  const event = readObjectRecord(raw);
  if (!event) return [];
  if (typeof event.type === 'string' && event.event === undefined) {
    return normalizeAgyTranscript([JSON.stringify(event)], sessionId ?? 'unknown');
  }
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
      } else {
        const brainFile = nativeTranscriptPath(providerSessionId);
        const fallbackBrainFile = nativeTranscriptPath(sessionId);
        const targetBrainFile = existsSync(brainFile) ? brainFile : (existsSync(fallbackBrainFile) ? fallbackBrainFile : null);
        if (targetBrainFile) {
          try {
            const rawContent = readFileSync(targetBrainFile, 'utf8');
            messages.push(...normalizeAgyTranscript(rawContent, sessionId, providerSessionId));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }

      const limit = options.limit ?? null;
      const offset = options.offset ?? 0;
      const { page, hasMore } = sliceTailPage(messages, limit, offset);
      return { messages: page, total: messages.length, hasMore, limit, offset };
    },
  };

  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AgySessionSynchronizer();

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
      let failed = false;
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

      const turnExecution = spawnDetachedTurn({
        command: 'agy',
        args,
        cwd: options.cwd || options.projectPath || process.cwd(),
        sessionId,
        backend: 'agy',
        jobId: typeof options.jobId === 'string' ? options.jobId : null,
        onLine: (val) => line(val),
        signal: options.abortController?.signal,
      });

      const { exitCode } = await turnExecution.promise;
      writer.send(createCompleteMessage({ provider: 'agy', sessionId, exitCode: failed ? 1 : exitCode, aborted: Boolean(options.abortController?.signal.aborted) }));
    },
    abort: (sessionId) => {
      const detachedStopped = abortTurn(sessionId);
      const proc = this.processes.get(sessionId);
      return detachedStopped || (proc?.kill('SIGTERM') ?? false);
    },
  };

  constructor() { super('agy'); }
}
