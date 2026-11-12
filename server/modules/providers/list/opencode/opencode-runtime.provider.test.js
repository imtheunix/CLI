import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getConnection } from '../../../database/index.js';

import {
  createOpenCodeTurnLineParser,
  opencodeRuntime,
  resolveOpenCodePermissionOptions,
} from './opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId || null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

const stripAttachArgs = (args) => {
  const index = args.indexOf('--attach');
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
};

const buildFakeOpenCodeScript = (runBody) => `
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'serve') {
  const portIndex = args.indexOf('--port');
  const port = Number(args[portIndex + 1]);
  const pidFile = process.env.OPENCODE_FAKE_SERVE_PID;
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
  const events = process.env.OPENCODE_FAKE_SSE_EVENTS ? JSON.parse(process.env.OPENCODE_FAKE_SSE_EVENTS) : [];
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/event')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\\n\\n');
      let index = 0;
      const sendNext = () => {
        if (index >= events.length) return;
        res.write('data: ' + JSON.stringify(events[index++]) + '\\n\\n');
        setTimeout(sendNext, 20);
      };
      setTimeout(sendNext, 20);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.listen(port, '127.0.0.1');
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
${runBody}
}
`;

const DEFAULT_FAKE_OPENCODE_SCRIPT = buildFakeOpenCodeScript(`
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
  }));
}

const events = [
  { type: 'text', sessionID: 'open-live-1', text: 'assistant response' },
  { type: 'step_finish', sessionID: 'open-live-1' },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
`);

async function createFakeOpenCodeExecutable(binDir, script = DEFAULT_FAKE_OPENCODE_SCRIPT) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, script, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-live-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run(
      'Hi',
      { cwd: tempRoot, model: 'github-copilot/gpt-5.6-terra' },
      writer,
      runtimeContext,
    );

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const assistantDeltaIndex = messages.findIndex((message) =>
      message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const streamEnd = messages.find((message) => message.kind === 'stream_end');
    const complete = messages.find((message) => message.kind === 'complete');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(assistantDeltaIndex, -1);
    assert.ok(sessionCreatedIndex < assistantDeltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    assert.equal(writer.sessionId, 'open-live-1');
    assert.equal(streamEnd?.sessionId, 'open-live-1');
    assert.equal(complete?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    const launchedArgs = capture.args;
    assert.ok(Array.isArray(launchedArgs));
    const attachAt = launchedArgs.indexOf('--attach');
    assert.ok(attachAt > 0);
    assert.match(launchedArgs[attachAt + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
    const runArgs = stripAttachArgs(launchedArgs);
    assert.deepEqual(runArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
    assert.equal(runArgs[4], tempRoot);
    assert.deepEqual(
      runArgs.slice(5, 7),
      ['--model', 'github-copilot/gpt-5.6-terra'],
    );
    // No permission mode requested → no permission flags and no env override.
    assert.equal(runArgs.includes('--auto'), false);
    assert.equal(runArgs.includes('--agent'), false);
    assert.equal(capture.permissionEnv, null);

    const attachmentOnlyCapturePath = path.join(tempRoot, 'opencode-attachment-only.json');
    process.env.OPENCODE_ARGS_CAPTURE = attachmentOnlyCapturePath;
    await opencodeRuntime.run(
      '',
      {
        cwd: tempRoot,
        files: [{
          path: path.join(tempRoot, 'brief.pdf'),
          name: 'brief.pdf',
          mimeType: 'application/pdf',
        }],
      },
      writer,
      runtimeContext,
    );
    const attachmentOnlyCapture = JSON.parse(await readFile(attachmentOnlyCapturePath, 'utf8'));
    const attachmentPrompt = attachmentOnlyCapture.args[attachmentOnlyCapture.args.length - 1];
    assert.match(attachmentPrompt, /<files_input>/);
    assert.match(attachmentPrompt, /brief\.pdf/);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveOpenCodePermissionOptions maps UI permission modes onto OpenCode controls', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), {
    args: ['--agent', 'plan'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), {
    args: ['--auto'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  // default and anything unknown leave the user's own opencode config in charge.
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

/** Shared harness for the CLI-argument tests: a fake `opencode` plus a capturing writer. */
async function withFakeOpenCode(run, script = DEFAULT_FAKE_OPENCODE_SCRIPT) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-args-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot, script);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }
    return await run(tempRoot, writer, messages);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function captureArgs(tempRoot, name) {
  const argsCapturePath = path.join(tempRoot, name);
  process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
  return argsCapturePath;
}

test('spawnOpenCode records its detached turns under the opencode provider', async () => {
  // Regression (2026-11-10): the turn row was recorded with backend 'glm', so
  // after a server restart the reattach ran a provider lookup with a label
  // that is not a provider and abort/lookup broke.
  await withFakeOpenCode(async (tempRoot, writer) => {
    await captureArgs(tempRoot, 'opencode-args-backend.json');
    await opencodeRuntime.run(
      'Hi',
      { cwd: tempRoot, sessionId: 'app-opencode-backend' },
      writer,
      runtimeContext,
    );

    const rows = getConnection()
      .prepare('SELECT backend, session_id FROM running_turns WHERE session_id = ?')
      .all('app-opencode-backend');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].backend, 'opencode');
  });
});

test('spawnOpenCode passes the session agent unless the permission mode already picked one', async () => {
  await withFakeOpenCode(async (tempRoot, writer) => {
    const argsCapturePath = await captureArgs(tempRoot, 'opencode-args-agent.json');
    await opencodeRuntime.run(
      'Hi',
      { cwd: tempRoot, agent: 'morph-hub' },
      writer,
      runtimeContext,
    );

    let capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.ok(capture.args.includes('--agent'));
    assert.ok(capture.args.includes('morph-hub'));
    // The prompt stays the last positional argument, after the agent flag.
    assert.equal(capture.args[capture.args.length - 1], 'Hi');

    const planCapturePath = await captureArgs(tempRoot, 'opencode-args-agent-plan.json');
    await opencodeRuntime.run(
      'Hi',
      { cwd: tempRoot, agent: 'morph-hub', permissionMode: 'plan' },
      writer,
      runtimeContext,
    );

    capture = JSON.parse(await readFile(planCapturePath, 'utf8'));
    // The turn's read-only plan agent outranks the session's standing one.
    assert.deepEqual(capture.args.slice(capture.args.indexOf('--agent'), capture.args.indexOf('--agent') + 2), ['--agent', 'plan']);
    assert.equal(capture.args.includes('morph-hub'), false);
  });
});

test('spawnOpenCode launches a morph model with its effort variant', async () => {
  const morphModels = {
    OPTIONS: [
      {
        value: 'morph/morph-dsv41flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Morph',
        effort: { values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
      },
    ],
    DEFAULT: 'morph/morph-dsv41flash',
  };
  const morphContext = { ...runtimeContext, getProviderModels: async () => morphModels };

  await withFakeOpenCode(async (tempRoot, writer) => {
    const argsCapturePath = await captureArgs(tempRoot, 'opencode-args-morph.json');
    await opencodeRuntime.run(
      'Hi',
      { cwd: tempRoot, model: 'morph/morph-dsv41flash', effort: 'medium' },
      writer,
      morphContext,
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    const modelAt = capture.args.indexOf('--model');
    assert.deepEqual(capture.args.slice(modelAt, modelAt + 2), ['--model', 'morph/morph-dsv41flash']);
    const variantAt = capture.args.indexOf('--variant');
    assert.deepEqual(capture.args.slice(variantAt, variantAt + 2), ['--variant', 'medium']);
    assert.equal(capture.args[capture.args.length - 1], 'Hi');
  });
});

test('spawnOpenCode passes permission mode flags and env to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-perms-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const scenarios = [
      {
        permissionMode: 'plan',
        expectArgs: ['--agent', 'plan'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'bypassPermissions',
        expectArgs: ['--auto'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'acceptEdits',
        expectArgs: [],
        expectPermissionEnv: '{"edit":"allow"}',
      },
    ];

    for (const scenario of scenarios) {
      const argsCapturePath = path.join(tempRoot, `opencode-args-${scenario.permissionMode}.json`);
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await opencodeRuntime.run(
        'Hi',
        { cwd: tempRoot, permissionMode: scenario.permissionMode },
        writer,
        runtimeContext,
      );

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      for (const expectedArg of scenario.expectArgs) {
        assert.ok(
          capture.args.includes(expectedArg),
          `${scenario.permissionMode}: expected "${expectedArg}" in ${JSON.stringify(capture.args)}`,
        );
      }
      // The prompt stays the last positional argument, after any permission flags.
      assert.equal(capture.args[capture.args.length - 1], 'Hi');
      assert.equal(capture.permissionEnv, scenario.expectPermissionEnv);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

const INCREMENTAL_OPENCODE_SCRIPT = buildFakeOpenCodeScript(`
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
say({ type: 'step_start', sessionID: 'open-live-1' });
const firstMarker = process.env.OPENCODE_FIRST_DELTA_MARKER;
const secondMarker = process.env.OPENCODE_SECOND_DELTA_MARKER;
const deadline = Date.now() + 3000;
while ((!fs.existsSync(firstMarker) || !fs.existsSync(secondMarker)) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (fs.existsSync(firstMarker) && fs.existsSync(secondMarker)) {
  say({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'open-live-1', type: 'text', text: 'Hello' },
  });
  say({ type: 'step_finish', sessionID: 'open-live-1' });
}
fs.writeFileSync(process.env.OPENCODE_EXIT_MARKER, String(Date.now()));
`);

const DELTA_LESS_OPENCODE_SCRIPT = buildFakeOpenCodeScript(`
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
say({
  type: 'text',
  sessionID: 'open-live-1',
  part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'open-live-1', type: 'text', text: 'Hello' },
});
say({ type: 'step_finish', sessionID: 'open-live-1' });
`);

test('spawnOpenCode streams the first text delta before the child exits and does not repeat the completed part', async () => {
  const previousDisableSystemd = process.env.CLI_DISABLE_SYSTEMD_RUN;
  const previousTurnsDir = process.env.CLI_TURNS_DIR;
  const previousFirstDeltaMarker = process.env.OPENCODE_FIRST_DELTA_MARKER;
  const previousSecondDeltaMarker = process.env.OPENCODE_SECOND_DELTA_MARKER;
  const previousExitMarker = process.env.OPENCODE_EXIT_MARKER;
  const previousSseEvents = process.env.OPENCODE_FAKE_SSE_EVENTS;
  process.env.CLI_DISABLE_SYSTEMD_RUN = '1';

  try {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      process.env.CLI_TURNS_DIR = path.join(tempRoot, 'turns');
      const firstDeltaMarker = path.join(tempRoot, 'first-delta');
      const secondDeltaMarker = path.join(tempRoot, 'second-delta');
      const exitMarker = path.join(tempRoot, 'child-exit');
      process.env.OPENCODE_FIRST_DELTA_MARKER = firstDeltaMarker;
      process.env.OPENCODE_SECOND_DELTA_MARKER = secondDeltaMarker;
      process.env.OPENCODE_EXIT_MARKER = exitMarker;
      process.env.OPENCODE_FAKE_SSE_EVENTS = JSON.stringify([
        {
          type: 'message.part.delta',
          properties: { sessionID: 'open-live-1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hel' },
        },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'subagent-session', messageID: 'msg_sub', partID: 'prt_sub', field: 'text', delta: 'leaked' },
        },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'open-live-1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'lo' },
        },
      ]);

      let firstDeltaAt = null;
      let deltaCount = 0;
      const originalSend = writer.send.bind(writer);
      writer.send = (message) => {
        if (message.kind === 'stream_delta') {
          deltaCount += 1;
          if (deltaCount === 1) {
            firstDeltaAt = Date.now();
            void writeFile(firstDeltaMarker, String(firstDeltaAt));
          } else if (deltaCount === 2) {
            void writeFile(secondDeltaMarker, String(Date.now()));
          }
        }
        originalSend(message);
      };

      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

      const exitAt = Number(await readFile(exitMarker, 'utf8'));
      assert.notEqual(firstDeltaAt, null);
      assert.ok(
        firstDeltaAt <= exitAt,
        `first stream_delta (${firstDeltaAt}) must reach the writer before the child exits (${exitAt})`,
      );

      const deltas = messages.filter((message) => message.kind === 'stream_delta');
      assert.deepEqual(deltas.map((message) => message.content), ['Hel', 'lo']);
      // The completed part repeats the streamed text; it must not be sent again.
      assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      assert.equal(messages.filter((message) => message.kind === 'stream_end').length, 1);
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    }, INCREMENTAL_OPENCODE_SCRIPT);
  } finally {
    if (previousDisableSystemd === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisableSystemd;
    if (previousTurnsDir === undefined) delete process.env.CLI_TURNS_DIR;
    else process.env.CLI_TURNS_DIR = previousTurnsDir;
    if (previousFirstDeltaMarker === undefined) delete process.env.OPENCODE_FIRST_DELTA_MARKER;
    else process.env.OPENCODE_FIRST_DELTA_MARKER = previousFirstDeltaMarker;
    if (previousSecondDeltaMarker === undefined) delete process.env.OPENCODE_SECOND_DELTA_MARKER;
    else process.env.OPENCODE_SECOND_DELTA_MARKER = previousSecondDeltaMarker;
    if (previousExitMarker === undefined) delete process.env.OPENCODE_EXIT_MARKER;
    else process.env.OPENCODE_EXIT_MARKER = previousExitMarker;
    if (previousSseEvents === undefined) delete process.env.OPENCODE_FAKE_SSE_EVENTS;
    else process.env.OPENCODE_FAKE_SSE_EVENTS = previousSseEvents;
  }
});

test('spawnOpenCode falls back to the completed part when the producer sent no deltas', async () => {
  const previousDisableSystemd = process.env.CLI_DISABLE_SYSTEMD_RUN;
  const previousTurnsDir = process.env.CLI_TURNS_DIR;
  process.env.CLI_DISABLE_SYSTEMD_RUN = '1';

  try {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      process.env.CLI_TURNS_DIR = path.join(tempRoot, 'turns');
      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

      const text = messages.filter((message) => message.kind === 'text');
      assert.deepEqual(text.map((message) => message.content), ['Hello']);
      assert.equal(messages.filter((message) => message.kind === 'stream_delta').length, 0);
      assert.equal(messages.filter((message) => message.kind === 'stream_end').length, 1);
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    }, DELTA_LESS_OPENCODE_SCRIPT);
  } finally {
    if (previousDisableSystemd === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisableSystemd;
    if (previousTurnsDir === undefined) delete process.env.CLI_TURNS_DIR;
    else process.env.CLI_TURNS_DIR = previousTurnsDir;
  }
});

test('OpenCode turn line parser primes streamed part ids so a reattached completed part is not repeated', () => {
  const parser = createOpenCodeTurnLineParser((raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId));
  const messages = [];
  const writer = {
    send(message) {
      messages.push(message);
    },
    setSessionId() {},
    getSessionId: () => 'open-live-1',
  };
  const deltaLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text' },
    delta: 'Hel',
  });
  const completedLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' },
  });

  // The pre-restart log only re-establishes state; it is not sent again.
  parser.prime([deltaLine], writer, 'app-session');
  assert.deepEqual(messages, []);

  parser(completedLine, writer, 'app-session');
  assert.deepEqual(messages, []);

  // A finished turn drops its tracking, so a later turn's completed part is a fallback again.
  parser.finish();
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].content, 'Hello');
});

test('OpenCode turn line parser resets streamed part ids when the live stream breaks', () => {
  const parser = createOpenCodeTurnLineParser((raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId));
  const messages = [];
  const writer = {
    send(message) {
      messages.push(message);
    },
    setSessionId() {},
    getSessionId: () => 'open-live-1',
  };
  const deltaLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text' },
    delta: 'Hel',
  });
  const completedLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' },
  });

  parser(deltaLine, writer, 'app-session');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');

  parser(JSON.stringify({ type: 'stream_reset' }), writer, 'app-session');
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].kind, 'text');
  assert.equal(messages[1].content, 'Hello');

  // A reset in the pre-restart log also clears the dedupe.
  parser.finish();
  parser.prime([deltaLine, JSON.stringify({ type: 'stream_reset' })], writer, 'app-session');
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 3);
  assert.equal(messages[2].kind, 'text');
  assert.equal(messages[2].content, 'Hello');
});

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(check, what, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

test('spawnOpenCode keeps every run option while attaching to the private server', async () => {
  const morphModels = {
    OPTIONS: [
      {
        value: 'morph/morph-dsv41flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Morph',
        effort: { values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
      },
    ],
    DEFAULT: 'morph/morph-dsv41flash',
  };
  const morphContext = { ...runtimeContext, getProviderModels: async () => morphModels };

  await withFakeOpenCode(async (tempRoot, writer) => {
    const argsCapturePath = await captureArgs(tempRoot, 'opencode-args-all.json');
    await opencodeRuntime.run(
      'Hi',
      {
        cwd: tempRoot,
        sessionId: 'app-session-all',
        model: 'morph/morph-dsv41flash',
        effort: 'medium',
        agent: 'morph-hub',
        permissionMode: 'acceptEdits',
        files: [{ path: path.join(tempRoot, 'brief.pdf'), name: 'brief.pdf', mimeType: 'application/pdf' }],
      },
      writer,
      morphContext,
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    const args = capture.args;
    const attachAt = args.indexOf('--attach');
    assert.ok(attachAt > 0);
    assert.match(args[attachAt + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
    const runArgs = stripAttachArgs(args);
    assert.deepEqual(runArgs.slice(0, 2), ['run', '--format']);
    assert.deepEqual(runArgs.slice(runArgs.indexOf('--session'), runArgs.indexOf('--session') + 2), ['--session', 'app-session-all']);
    assert.deepEqual(runArgs.slice(runArgs.indexOf('--model'), runArgs.indexOf('--model') + 2), ['--model', 'morph/morph-dsv41flash']);
    assert.deepEqual(runArgs.slice(runArgs.indexOf('--variant'), runArgs.indexOf('--variant') + 2), ['--variant', 'medium']);
    assert.deepEqual(runArgs.slice(runArgs.indexOf('--agent'), runArgs.indexOf('--agent') + 2), ['--agent', 'morph-hub']);
    assert.equal(capture.permissionEnv, '{"edit":"allow"}');
    assert.match(runArgs[runArgs.length - 1], /<files_input>/);
    assert.match(runArgs[runArgs.length - 1], /brief\.pdf/);
  });
});

test('spawnOpenCode stops the private serve after a normal run', async () => {
  const previousDisableSystemd = process.env.CLI_DISABLE_SYSTEMD_RUN;
  const previousTurnsDir = process.env.CLI_TURNS_DIR;
  const previousServePid = process.env.OPENCODE_FAKE_SERVE_PID;
  process.env.CLI_DISABLE_SYSTEMD_RUN = '1';

  try {
    await withFakeOpenCode(async (tempRoot, writer) => {
      process.env.CLI_TURNS_DIR = path.join(tempRoot, 'turns');
      const servePidPath = path.join(tempRoot, 'serve.pid');
      process.env.OPENCODE_FAKE_SERVE_PID = servePidPath;
      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);
      const servePid = Number(await readFile(servePidPath, 'utf8'));
      await eventually(() => !isPidAlive(servePid), 'the private serve to exit');
    });
  } finally {
    if (previousDisableSystemd === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisableSystemd;
    if (previousTurnsDir === undefined) delete process.env.CLI_TURNS_DIR;
    else process.env.CLI_TURNS_DIR = previousTurnsDir;
    if (previousServePid === undefined) delete process.env.OPENCODE_FAKE_SERVE_PID;
    else process.env.OPENCODE_FAKE_SERVE_PID = previousServePid;
  }
});

test('spawnOpenCode stops the private serve when run fails', async () => {
  const previousDisableSystemd = process.env.CLI_DISABLE_SYSTEMD_RUN;
  const previousTurnsDir = process.env.CLI_TURNS_DIR;
  const previousServePid = process.env.OPENCODE_FAKE_SERVE_PID;
  process.env.CLI_DISABLE_SYSTEMD_RUN = '1';
  const failingScript = buildFakeOpenCodeScript('process.exit(1);');

  try {
    await withFakeOpenCode(async (tempRoot, writer) => {
      process.env.CLI_TURNS_DIR = path.join(tempRoot, 'turns');
      const servePidPath = path.join(tempRoot, 'serve.pid');
      process.env.OPENCODE_FAKE_SERVE_PID = servePidPath;
      await assert.rejects(
        opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext),
        /exited with code 1/,
      );
      const servePid = Number(await readFile(servePidPath, 'utf8'));
      await eventually(() => !isPidAlive(servePid), 'the private serve to exit after a failed run');
    }, failingScript);
  } finally {
    if (previousDisableSystemd === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisableSystemd;
    if (previousTurnsDir === undefined) delete process.env.CLI_TURNS_DIR;
    else process.env.CLI_TURNS_DIR = previousTurnsDir;
    if (previousServePid === undefined) delete process.env.OPENCODE_FAKE_SERVE_PID;
    else process.env.OPENCODE_FAKE_SERVE_PID = previousServePid;
  }
});

test('aborting a turn stops the private serve', async () => {
  const previousDisableSystemd = process.env.CLI_DISABLE_SYSTEMD_RUN;
  const previousTurnsDir = process.env.CLI_TURNS_DIR;
  const previousServePid = process.env.OPENCODE_FAKE_SERVE_PID;
  process.env.CLI_DISABLE_SYSTEMD_RUN = '1';
  const hangingScript = buildFakeOpenCodeScript('setInterval(() => {}, 1000);');

  try {
    await withFakeOpenCode(async (tempRoot, writer) => {
      process.env.CLI_TURNS_DIR = path.join(tempRoot, 'turns');
      const servePidPath = path.join(tempRoot, 'serve.pid');
      process.env.OPENCODE_FAKE_SERVE_PID = servePidPath;
      const runPromise = opencodeRuntime.run(
        'Hi',
        { cwd: tempRoot, sessionId: 'app-opencode-abort' },
        writer,
        runtimeContext,
      ).catch(() => undefined);

      await eventually(async () => {
        try {
          await readFile(servePidPath, 'utf8');
          return true;
        } catch {
          return false;
        }
      }, 'the private serve to start');

      const servePid = Number(await readFile(servePidPath, 'utf8'));
      assert.equal(opencodeRuntime.abort('app-opencode-abort'), true);
      await runPromise;
      await eventually(() => !isPidAlive(servePid), 'the private serve to exit after abort');
    }, hangingScript);
  } finally {
    if (previousDisableSystemd === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisableSystemd;
    if (previousTurnsDir === undefined) delete process.env.CLI_TURNS_DIR;
    else process.env.CLI_TURNS_DIR = previousTurnsDir;
    if (previousServePid === undefined) delete process.env.OPENCODE_FAKE_SERVE_PID;
    else process.env.OPENCODE_FAKE_SERVE_PID = previousServePid;
  }
});
