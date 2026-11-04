import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * One chat session must never have two live CLI processes. When a new turn
 * supersedes a process still registered for its session, the old one is told
 * to stop its tasks and interrupt while its stdin is still open, then let go,
 * then terminated by its own handle if it lingers; whatever it emits after
 * that never reaches the client. These drive `queryClaudeSDK` with a scripted
 * SDK stream (`context.createQuery`) and a fake child (`context.spawnProcess`).
 */

process.env.CLAUDE_SUPERSEDE_GRACE_MS = '60';
process.env.CLAUDE_SUPERSEDE_KILL_AFTER_MS = '60';

const SESSION_ID = 'app-supersede-session';
const NATIVE_ID = 'native-supersede-session';

/** A stand-in CLI child: records signals; SIGTERM is ignored unless `exitOnTerm`. */
class FakeChild extends EventEmitter {
  static nextPid = 41000;
  pid = FakeChild.nextPid++;
  exitCode: number | null = null;
  signals: string[] = [];
  constructor(private readonly exitOnTerm = false) { super(); }
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || this.exitOnTerm) {
      this.exitCode = 1;
      this.emit('exit', null, signal);
    }
    return true;
  }
}

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  child: FakeChild;
  /** Ordered control traffic: `stop:<id>`, `interrupt`, `stdin closed`. */
  log: string[];
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>;
};

function createScriptedProcess(): Scripted {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  const log: string[] = [];
  const child = new FakeChild();

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    // The SDK spawns through the hook the runtime installs.
    options.spawnClaudeCodeProcess({ command: 'claude', args: [], env: {} });
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      log.push('stdin closed');
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => { log.push('interrupt'); },
      stopTask: async (taskId: string) => { log.push(`stop:${taskId}`); },
    });
  };

  return {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    child,
    log,
    createQuery,
  };
}

const settle = (ms = 25) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const text = (value: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: value }] },
});
const backgroundBash = () => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'tjob watch', run_in_background: true } }] },
});
const taskStarted = () => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: 'b1', tool_use_id: 'toolu_bg', description: 'Task b1', task_type: 'local_bash',
});
const taskNotification = (status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: 'b1', tool_use_id: 'toolu_bg', status, summary: `Task b1 ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });

async function withSession(
  runTest: (session: {
    start: (prompt: string, scripted: Scripted) => Promise<unknown>;
    sent: NormalizedMessage[];
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-supersede-'));
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const start = (prompt: string, scripted: Scripted) => queryClaudeSDK(prompt, { sessionId: SESSION_ID, cwd }, writer as never, {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw: unknown, sessionId: string | null) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: scripted.createQuery,
    spawnProcess: () => scripted.child,
  });
  try {
    await runTest({ start, sent });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Run A: a turn that leaves a background Bash outstanding, then a task notification starts a turn in it. */
async function holdWithTurnInProgress(start: (prompt: string, scripted: Scripted) => Promise<unknown>, sent: NormalizedMessage[], first: Scripted) {
  const run = start('watch the jobs', first);
  await settle();
  first.emit(init());
  first.emit(backgroundBash());
  first.emit(taskStarted());
  first.emit(result());
  await waitFor(() => sent.some((message) => message.kind === 'complete'));
  assert.ok(!first.log.includes('stdin closed'), 'the first process is held for its background task');
  first.emit(text('a notification turn in progress'));
  await settle();
  // Wrapped: returning the bare promise would make callers wait for the run to end.
  return { run };
}

test('a superseded process is stopped and interrupted before its stdin closes', async () => {
  await withSession(async ({ start, sent }) => {
    const first = createScriptedProcess();
    const second = createScriptedProcess();
    const { run: firstRun } = await holdWithTurnInProgress(start, sent, first);

    const secondRun = start('the user message', second);
    await waitFor(() => first.log.includes('stdin closed'));
    assert.deepEqual(first.log, ['stop:b1', 'interrupt', 'stdin closed'], 'control requests reach the CLI while stdin is open');
    assert.deepEqual(second.log, [], 'the new process is untouched');
    assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'the old task set is not carried over');

    first.end();
    second.emit(init());
    second.emit(result());
    second.end();
    await Promise.all([firstRun, secondRun]);
  });
});

test('a superseded process that stays alive is terminated by its own handle, and its output is dropped', async () => {
  await withSession(async ({ start, sent }) => {
    const first = createScriptedProcess();
    const second = createScriptedProcess();
    const { run: firstRun } = await holdWithTurnInProgress(start, sent, first);

    const secondRun = start('the user message', second);
    await waitFor(() => first.log.includes('stdin closed'));
    const completes = sent.filter((message) => message.kind === 'complete').length;

    // The ghost keeps talking: a reply, a background completion, a result.
    first.emit(text('ghost reply'));
    first.emit(taskNotification('completed'));
    first.emit(result());
    await settle();
    assert.ok(!JSON.stringify(sent).includes('ghost reply'), 'nothing the superseded process says reaches the client');
    assert.equal(sent.filter((message) => message.kind === 'complete').length, completes, 'and it reports no completion');
    assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'nor touches the session registry');

    // Grace period (60 ms here), SIGTERM ignored, then SIGKILL after 60 ms.
    await waitFor(() => first.child.signals.includes('SIGKILL'));
    assert.deepEqual(first.child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(second.child.signals, [], 'the new process is never signalled');

    first.end();
    second.emit(init());
    second.emit(text('the real reply'));
    second.emit(result());
    second.end();
    await Promise.all([firstRun, secondRun]);
    assert.ok(JSON.stringify(sent).includes('the real reply'));
  });
});

test('a superseded process that exits on its own is not signalled', async () => {
  await withSession(async ({ start, sent }) => {
    const first = createScriptedProcess();
    const second = createScriptedProcess();
    const { run: firstRun } = await holdWithTurnInProgress(start, sent, first);

    const secondRun = start('the user message', second);
    await waitFor(() => first.log.includes('stdin closed'));
    first.child.exitCode = 0;
    first.child.emit('exit', 0, null);
    first.end();
    await settle(200);
    assert.deepEqual(first.child.signals, []);

    second.emit(init());
    second.emit(result());
    second.end();
    await Promise.all([firstRun, secondRun]);
  });
});

test('with nothing superseding it, background work still reports back and the process is left alone', async () => {
  await withSession(async ({ start, sent }) => {
    const only = createScriptedProcess();
    const run = start('watch the jobs', only);
    await settle();
    only.emit(init());
    only.emit(backgroundBash());
    only.emit(taskStarted());
    only.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.ok(!only.log.includes('stdin closed'), 'held for the background task');

    only.emit(taskNotification('completed'));
    only.emit(text('the watch finished'));
    only.emit(result());
    await waitFor(() => only.log.includes('stdin closed'));
    assert.ok(JSON.stringify(sent).includes('the watch finished'), 'the follow-up turn reaches the client');
    assert.deepEqual(only.log, ['stdin closed'], 'no stop or interrupt');

    only.end();
    await run;
    await settle(200);
    assert.deepEqual(only.child.signals, [], 'never signalled');
  });
});
