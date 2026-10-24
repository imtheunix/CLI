import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null, resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ DEFAULT: '', OPTIONS: [] }),
  normalizeMessage: () => [], isProviderInstalled: async () => true,
};

test('Claude receives the reserved controller in the SDK and releases stdin on cancellation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-stop-'));
  const controller = new AbortController();
  let sdkController: AbortController | undefined;
  let stdinClosed = false;
  let approvalSettled = false;
  let ready!: () => void;
  const initialized = new Promise<void>((resolve) => { ready = resolve; });
  const frames: AnyRecord[] = [];
  try {
    const done = claudeRuntime.run('work', { sessionId: 'claude-stop', cwd: directory, abortController: controller }, { send: (frame: AnyRecord) => frames.push(frame) }, {
      ...context,
      createQuery: ({ prompt, options }: Parameters<NonNullable<ProviderRuntimeContext['createQuery']>>[0]) => {
        sdkController = options.abortController;
        // A tool awaiting a phone's answer must be cancelled with the run too.
        void options.canUseTool('AskUserQuestion', { questions: [] }, {}).then(() => { approvalSettled = true; });
        void (async () => { for await (const _message of prompt) { /* drain CLI stdin */ } stdinClosed = true; })();
        return Object.assign((async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'native-stop' };
          ready();
          await new Promise<void>((resolve) => sdkController?.signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new Error('cancelled');
        })(), { interrupt: async () => {} });
      },
    });
    await initialized;
    assert.equal(sdkController, controller);
    controller.abort();
    await done;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stdinClosed, true);
    assert.equal(approvalSettled, true, 'cancellation must release pending permissions');
    assert.ok(!frames.some((frame) => frame.kind === 'error'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode/GLM cancellation terminates a real local CLI subprocess', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-stop-'));
  const oldPath = process.env.PATH;
  const controller = new AbortController();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let pid: number | undefined;
  try {
    const executable = path.join(directory, 'opencode');
    await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: 'ready', pid: process.pid }));\nsetInterval(() => {}, 1000);\n`);
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ''}`;
    const done = opencodeRuntime.run('work', { sessionId: 'opencode-stop', cwd: directory, model: 'zai-coding-plan/glm-5.3', abortController: controller }, { send: () => {} }, {
      ...context,
      normalizeMessage: (raw: unknown) => { pid = (raw as { pid: number }).pid; started(); return []; },
    });
    await running;
    controller.abort();
    await done;
    // close/error can arrive separately; wait for the child to be reaped.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(pid!, 0); } catch { return; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('OpenCode subprocess survived cancellation');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});
