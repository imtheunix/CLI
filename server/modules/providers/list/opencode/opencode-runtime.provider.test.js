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
const waitForFile = (file, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return fs.existsSync(file);
};
if (args[0] === 'serve') {
  if (process.env.OPENCODE_FAKE_SERVE_FAIL === '1') {
    process.exit(1);
  }
  const portIndex = args.indexOf('--port');
  const port = Number(args[portIndex + 1]);
  const pidFile = process.env.OPENCODE_FAKE_SERVE_PID;
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
  const frames = process.env.OPENCODE_FAKE_SSE_FRAMES ? JSON.parse(process.env.OPENCODE_FAKE_SSE_FRAMES) : null;
  const events = process.env.OPENCODE_FAKE_SSE_EVENTS ? JSON.parse(process.env.OPENCODE_FAKE_SSE_EVENTS) : [];
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/event')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\\n\\n');
      const finish = () => {
        if (process.env.OPENCODE_FAKE_SSE_SENT) fs.writeFileSync(process.env.OPENCODE_FAKE_SSE_SENT, String(Date.now()));
        if (process.env.OPENCODE_FAKE_SSE_CLOSE === '1') res.end();
      };
      if (frames) {
        let index = 0;
        const sendNext = () => {
          if (index >= frames.length) { finish(); return; }
          const frame = frames[index++];
          if (frame && typeof frame === 'object' && frame.waitFor) {
            waitForFile(frame.waitFor, 5000);
            sendNext();
            return;
          }
          if (frame && typeof frame === 'object' && frame.destroy) {
            res.destroy();
            return;
          }
          res.write(typeof frame === 'string' ? frame : 'data: ' + JSON.stringify(frame) + '\\n\\n');
          setTimeout(sendNext, 20);
        };
        setTimeout(sendNext, 20);
        return;
      }
      let index = 0;
      const sendNext = () => {
        if (index >= events.length) { finish(); return; }
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

test('spawnOpenCode awaits the detached execution and reports the CLI exit code', async () => {
  // Regression (2026-11-10): spawnDetachedTurn became async. The runtime must
  // await it before reading `.promise`; otherwise every turn dies destructuring
  // undefined instead of reporting the CLI's real exit code.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-exit-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
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
    // Serve-aware fixture: the bridge starts a private serve before the run,
    // so the fake CLI must answer the serve subcommand as well as the run.
    await createFakeOpenCodeExecutable(tempRoot, buildFakeOpenCodeScript(`
console.log(JSON.stringify({ type: 'text', sessionID: 'open-exit-1', text: 'bye' }));
process.exit(3);
`));

    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await assert.rejects(
      opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext),
      /exited with code 3/,
    );

    const complete = messages.find((message) => message.kind === 'complete');
    assert.equal(complete?.exitCode, 3);
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

test('OpenCode turn line parser primes a partial stream and sends only the completion remainder', () => {
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

  // Only the missing suffix is sent, so the client's live buffer reaches
  // "Hello" without a second assistant bubble.
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, 'lo');

  // A finished turn drops its tracking, so a later turn's completed part is a fallback again.
  parser.finish();
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].kind, 'text');
  assert.equal(messages[1].content, 'Hello');
});

test('OpenCode turn line parser suppresses an equal full completion after priming', () => {
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
    delta: 'Hello',
  });
  const completedLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' },
  });

  parser.prime([deltaLine], writer, 'app-session');
  parser(completedLine, writer, 'app-session');
  assert.deepEqual(messages, []);
});

test('OpenCode turn line parser keeps the streamed prefix across a reset and ignores late deltas', () => {
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
  const lateDeltaLine = JSON.stringify({
    type: 'text',
    sessionID: 'open-live-1',
    part: { id: 'prt_1', messageID: 'msg_1', type: 'text' },
    delta: 'late',
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
  // The dead stream must not append anything after the reset.
  parser(lateDeltaLine, writer, 'app-session');
  assert.equal(messages.length, 1);

  // The authoritative completion still restores the missing suffix.
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].kind, 'stream_delta');
  assert.equal(messages[1].content, 'lo');

  // A reset in the pre-restart log behaves the same way.
  parser.finish();
  parser.prime([deltaLine, JSON.stringify({ type: 'stream_reset' })], writer, 'app-session');
  parser(completedLine, writer, 'app-session');
  assert.equal(messages.length, 3);
  assert.equal(messages[2].kind, 'stream_delta');
  assert.equal(messages[2].content, 'lo');
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

/** Sets environment variables for one test and restores the previous values. */
async function withEnv(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const sseDeltaFrame = (id, text, sessionId = 'open-live-1', partId = 'prt_1') => {
  const prefix = id ? `id: ${id}\n` : '';
  return `${prefix}data: ${JSON.stringify({
    type: 'message.part.delta',
    properties: {
      sessionID: sessionId,
      messageID: 'msg_1',
      partID: partId,
      field: 'text',
      delta: text,
    },
  })}\n\n`;
};

test('spawnOpenCode falls back to an ordinary run when the private serve cannot start', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1', OPENCODE_FAKE_SERVE_FAIL: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      await withEnv({ CLI_TURNS_DIR: path.join(tempRoot, 'turns') }, async () => {
        const argsCapturePath = await captureArgs(tempRoot, 'opencode-args-fallback.json');
        await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

        const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
        assert.equal(capture.args.includes('--attach'), false);
        assert.deepEqual(
          messages.filter((message) => message.kind === 'text').map((message) => message.content),
          ['Hello'],
        );
        assert.equal(messages.some((message) => message.kind === 'error'), false);
        assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
      });
    }, buildFakeOpenCodeScript(`
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2) }));
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});

test('spawnOpenCode resets a clean early SSE EOF and restores the completed text', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const runGo = path.join(tempRoot, 'run-go');
      const sseSent = path.join(tempRoot, 'sse-sent');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([sseDeltaFrame(null, 'Hel')]),
        OPENCODE_FAKE_SSE_CLOSE: '1',
        OPENCODE_FAKE_SSE_SENT: sseSent,
        OPENCODE_RUN_GO: runGo,
      }, async () => {
        let firstDelta;
        const firstDeltaPromise = new Promise((resolve) => { firstDelta = resolve; });
        const originalSend = writer.send.bind(writer);
        writer.send = (message) => {
          originalSend(message);
          if (message.kind === 'stream_delta') firstDelta();
        };

        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'open-live-1' },
          writer,
          runtimeContext,
        );
        await firstDeltaPromise;
        await writeFile(runGo, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['Hel', 'lo']);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_RUN_GO, 5000);
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});

test('spawnOpenCode resets a failed SSE stream and restores the completed text', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const runGo = path.join(tempRoot, 'run-go');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([sseDeltaFrame(null, 'Hel'), { destroy: true }]),
        OPENCODE_RUN_GO: runGo,
      }, async () => {
        let firstDelta;
        const firstDeltaPromise = new Promise((resolve) => { firstDelta = resolve; });
        const originalSend = writer.send.bind(writer);
        writer.send = (message) => {
          originalSend(message);
          if (message.kind === 'stream_delta') firstDelta();
        };

        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'open-live-1' },
          writer,
          runtimeContext,
        );
        await firstDeltaPromise;
        await writeFile(runGo, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['Hel', 'lo']);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_RUN_GO, 5000);
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});

test('spawnOpenCode selects the exact root from run stdout and discards subagent deltas', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const rootGo = path.join(tempRoot, 'root-go');
      const sseSent = path.join(tempRoot, 'sse-sent');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([
          sseDeltaFrame(null, 'leaked', 'subagent-session', 'prt_sub'),
          sseDeltaFrame(null, 'Hel'),
        ]),
        OPENCODE_FAKE_SSE_SENT: sseSent,
        OPENCODE_ROOT_GO: rootGo,
      }, async () => {
        const runPromise = opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);
        await eventually(async () => {
          try {
            await readFile(sseSent, 'utf8');
            return true;
          } catch {
            return false;
          }
        }, 'the SSE frames to be sent');

        // No root is known yet, so no delta may have been forwarded.
        assert.equal(messages.filter((message) => message.kind === 'stream_delta').length, 0);
        await writeFile(rootGo, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['Hel', 'lo']);
        assert.equal(messages.some((message) => message.content === 'leaked'), false);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_ROOT_GO, 5000);
console.log(JSON.stringify({ type: 'step_start', sessionID: 'open-live-1' }));
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});

test('spawnOpenCode suppresses replayed SSE event ids but keeps repeated chunks with different ids', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const runGo = path.join(tempRoot, 'run-go');
      const completed = path.join(tempRoot, 'completed');
      const runDone = path.join(tempRoot, 'run-done');
      const sseSent = path.join(tempRoot, 'sse-sent');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([
          sseDeltaFrame('evt1', 'A'),
          sseDeltaFrame('evt1', 'A'),
          sseDeltaFrame('evt2', 'A'),
          { waitFor: completed },
          sseDeltaFrame('evt3', 'B'),
        ]),
        OPENCODE_FAKE_SSE_SENT: sseSent,
        OPENCODE_RUN_GO: runGo,
        OPENCODE_COMPLETED: completed,
        OPENCODE_RUN_DONE: runDone,
      }, async () => {
        let deltaCount = 0;
        let twoDeltas;
        const twoDeltasPromise = new Promise((resolve) => { twoDeltas = resolve; });
        const originalSend = writer.send.bind(writer);
        writer.send = (message) => {
          originalSend(message);
          if (message.kind === 'stream_delta') {
            deltaCount += 1;
            if (deltaCount === 2) twoDeltas();
          }
        };

        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'open-live-1' },
          writer,
          runtimeContext,
        );
        await twoDeltasPromise;
        await writeFile(runGo, '1');
        await eventually(async () => {
          try {
            await readFile(sseSent, 'utf8');
            return true;
          } catch {
            return false;
          }
        }, 'the late SSE frame to be sent');
        await writeFile(runDone, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['A', 'A']);
        assert.equal(messages.some((message) => message.content === 'B'), false);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'AA').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_RUN_GO, 5000);
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'AA' } }));
fs.writeFileSync(process.env.OPENCODE_COMPLETED, '1');
waitForFile(process.env.OPENCODE_RUN_DONE, 5000);
`));
  });
});

test('spawnOpenCode parses split and multiline SSE frames', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const runGo = path.join(tempRoot, 'run-go');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([
          'id: evt1\ndata: {"type":"message.part.delta","properties":',
          '{"sessionID":"open-live-1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"Hel"}}\n\n',
          'id: evt2\ndata: {"type":"message.part.delta",\ndata: "properties":{"sessionID":"open-live-1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"lo"}}\n\n',
        ]),
        OPENCODE_RUN_GO: runGo,
      }, async () => {
        let deltaCount = 0;
        let twoDeltas;
        const twoDeltasPromise = new Promise((resolve) => { twoDeltas = resolve; });
        const originalSend = writer.send.bind(writer);
        writer.send = (message) => {
          originalSend(message);
          if (message.kind === 'stream_delta') {
            deltaCount += 1;
            if (deltaCount === 2) twoDeltas();
          }
        };

        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'open-live-1' },
          writer,
          runtimeContext,
        );
        await twoDeltasPromise;
        await writeFile(runGo, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['Hel', 'lo']);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_RUN_GO, 5000);
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});

const descendantRunScript = (exitCode) => buildFakeOpenCodeScript(`
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(process.env.OPENCODE_FAKE_RUN_CHILD_PID, String(child.pid));
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
process.exit(${exitCode});
`);

const descendantHangingScript = buildFakeOpenCodeScript(`
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(process.env.OPENCODE_FAKE_RUN_CHILD_PID, String(child.pid));
setInterval(() => {}, 1000);
`);

test('spawnOpenCode kills run descendants on normal completion', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer) => {
      const childPidPath = path.join(tempRoot, 'run-child.pid');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_RUN_CHILD_PID: childPidPath,
      }, async () => {
        await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);
        const childPid = Number(await readFile(childPidPath, 'utf8'));
        await eventually(() => !isPidAlive(childPid), 'the run descendant to exit');
      });
    }, descendantRunScript(0));
  });
});

test('spawnOpenCode kills run descendants when run fails', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer) => {
      const childPidPath = path.join(tempRoot, 'run-child.pid');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_RUN_CHILD_PID: childPidPath,
      }, async () => {
        await assert.rejects(
          opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext),
          /exited with code 1/,
        );
        const childPid = Number(await readFile(childPidPath, 'utf8'));
        await eventually(() => !isPidAlive(childPid), 'the run descendant to exit after a failed run');
      });
    }, descendantRunScript(1));
  });
});

test('spawnOpenCode kills run descendants on abort', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer) => {
      const childPidPath = path.join(tempRoot, 'run-child.pid');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_RUN_CHILD_PID: childPidPath,
      }, async () => {
        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'app-opencode-descendant-abort' },
          writer,
          runtimeContext,
        ).catch(() => undefined);

        await eventually(async () => {
          try {
            await readFile(childPidPath, 'utf8');
            return true;
          } catch {
            return false;
          }
        }, 'the run descendant to start');

        const childPid = Number(await readFile(childPidPath, 'utf8'));
        assert.equal(opencodeRuntime.abort('app-opencode-descendant-abort'), true);
        await runPromise;
        await eventually(() => !isPidAlive(childPid), 'the run descendant to exit after abort');
      });
    }, descendantHangingScript);
  });
});

test('spawnOpenCode forwards session.next.text.delta events', async () => {
  await withEnv({ CLI_DISABLE_SYSTEMD_RUN: '1' }, async () => {
    await withFakeOpenCode(async (tempRoot, writer, messages) => {
      const runGo = path.join(tempRoot, 'run-go');
      await withEnv({
        CLI_TURNS_DIR: path.join(tempRoot, 'turns'),
        OPENCODE_FAKE_SSE_FRAMES: JSON.stringify([
          `data: ${JSON.stringify({
            type: 'session.next.text.delta',
            properties: {
              sessionID: 'open-live-1',
              assistantMessageID: 'msg_1',
              textID: 'prt_1',
              delta: 'Hel',
            },
          })}\n\n`,
        ]),
        OPENCODE_RUN_GO: runGo,
      }, async () => {
        let firstDelta;
        const firstDeltaPromise = new Promise((resolve) => { firstDelta = resolve; });
        const originalSend = writer.send.bind(writer);
        writer.send = (message) => {
          originalSend(message);
          if (message.kind === 'stream_delta') firstDelta();
        };

        const runPromise = opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, sessionId: 'open-live-1' },
          writer,
          runtimeContext,
        );
        await firstDeltaPromise;
        await writeFile(runGo, '1');
        await runPromise;

        const deltas = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
        assert.deepEqual(deltas, ['Hel', 'lo']);
        assert.equal(messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0);
      });
    }, buildFakeOpenCodeScript(`
waitForFile(process.env.OPENCODE_RUN_GO, 5000);
console.log(JSON.stringify({ type: 'text', sessionID: 'open-live-1', part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello' } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'open-live-1' }));
`));
  });
});
