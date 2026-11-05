import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { createClaudeTurnLineParser, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Claude Code re-invokes the model when background work a turn started
 * reports back, after that turn's `result`. Fed a stream result -> assistant
 * -> result, both the in-process loop and the detached relay's parser must
 * put the run back to running and end it again: two completions (two
 * turn_ended for a job, two hub wakes), the session working -> waiting ->
 * working -> waiting. The jobs side of the same contract is in
 * orchestrator.test.ts.
 */

const NATIVE_ID = 'native-resumed-session';
const assistant = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const result = (text: string) => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: text, duration_ms: 1, num_turns: 1 });
const STREAM = [
  { type: 'system', subtype: 'init', session_id: NATIVE_ID },
  assistant('Started the workflow in the background.'),
  result('launched'),
  { type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: 'wf1', tool_use_id: 'toolu_wf', status: 'completed', summary: 'done', output_file: '' },
  assistant('Final report.'),
  result('Final report.'),
];
// Look after: init+assistant, the first result, the notification+assistant, the second result.
const STOPS = [2, 3, 5, 6];
const EXPECTED = { states: ['working', 'waiting', 'working', 'waiting'], completions: [0, 1, 1, 2] };

const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
const normalize = (raw: unknown, sessionId: string | null) => sessions.normalizeMessage(raw as never, sessionId as never);

async function withRun(
  appSessionId: string,
  feedUpTo: (upTo: number, writer: { send: (message: NormalizedMessage) => void }) => Promise<void>,
): Promise<{ states: string[]; completions: number[] }> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'claude-turn-resumed-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  userDb.createUser('resumed', 'hash');
  sessionsDb.createAppSession(appSessionId, 'claude', root);
  let completed = 0;
  const unsubscribe = chatRunRegistry.onRunCompleted((completion) => {
    if (completion.appSessionId === appSessionId) completed += 1;
  });
  try {
    const run = chatRunRegistry.startRun({ appSessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    const states: string[] = [];
    const completions: number[] = [];
    for (const upTo of STOPS) {
      await feedUpTo(upTo, run.writer);
      states.push(chatRunRegistry.isProcessing(appSessionId) ? 'working' : 'waiting');
      completions.push(completed);
    }
    return { states, completions };
  } finally {
    unsubscribe();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('in-process: a result, then more model output, then a result is two turns ending', async () => {
  let allowed = 0;
  let consumed = 0;
  let wake: (() => void) | null = null;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => { for await (const _ of prompt) { /* the CLI reads its stdin */ } })();
    return Object.assign((async function* () {
      for (const message of STREAM) {
        while (consumed >= allowed) await new Promise<void>((resolve) => { wake = resolve; });
        consumed += 1;
        yield message;
      }
    })(), { interrupt: async () => {}, stopTask: async () => {} });
  };
  let done: Promise<unknown> | null = null;
  const observed = await withRun('app-resumed-live', async (upTo, writer) => {
    allowed = upTo;
    if (!done) {
      done = queryClaudeSDK('hello', { sessionId: 'app-resumed-live', cwd: tmpdir() }, writer as never, {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
        normalizeMessage: normalize as never,
        isProviderInstalled: async () => true,
        createQuery,
      });
    }
    wake?.();
    for (let i = 0; i < 200 && consumed < upTo; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await done;
  assert.deepEqual({ states: observed.states, completions: observed.completions }, EXPECTED);
});

test('detached: the relay parser turns result -> assistant -> result into two turns ending', async () => {
  const parser = createClaudeTurnLineParser(normalize);
  let fed = 0;
  const observed = await withRun('app-resumed-relayed', async (upTo, writer) => {
    for (; fed < upTo; fed += 1) parser(JSON.stringify(STREAM[fed]), writer as never, 'app-resumed-relayed');
  });
  assert.deepEqual({ states: observed.states, completions: observed.completions }, EXPECTED);
});

test('a subagent message after the result is not the model resuming', async () => {
  const parser = createClaudeTurnLineParser(normalize);
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); } };
  for (const message of [STREAM[0], STREAM[1], STREAM[2], { ...assistant('subagent chatter'), parent_tool_use_id: 'toolu_agent' }]) {
    parser(JSON.stringify(message), writer as never, 'app-resumed-subagent');
  }
  assert.equal(sent.filter((message) => message.turnResumed).length, 0);
  assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
});
