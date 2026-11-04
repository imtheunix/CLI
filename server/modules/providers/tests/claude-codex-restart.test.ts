import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, runningTurnsDb, userDb } from '@/modules/database/index.js';
import { createClaudeTurnLineParser, spawnDetachableClaudeProcess } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

import {
  getTurnLogPath,
  isSystemdRunAvailable,
  isTurnAlive,
  prepareDetachedExec,
  reattachActiveTurns,
  registerBackendLineParser,
  resetSystemdRunCache,
  retireDetachedSessionTurns,
  readRelayExit,
  spawnRelayedTurn,
} from '@/modules/detached-turns/index.js';

const RELAY_CLIENT = fileURLToPath(new URL('../../detached-turns/relay/relay-process.js', import.meta.url));
const systemd = isSystemdRunAvailable();

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake `claude` speaking stream-json: on a user message it says something,
 * asks for a tool permission (control_request), reports what it was told,
 * says more, then reports the turn's `result`. It exits when stdin closes.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const text = (t) => say({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
let buffer = '';
let waitingFor = null;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'user') {
      say({ type: 'system', subtype: 'init', session_id: 'native-1' });
      setTimeout(() => text('part 1'), 100);
      setTimeout(() => {
        waitingFor = 'req-1';
        say({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
      }, 300);
    } else if (m.type === 'control_response' && m.response.request_id === waitingFor) {
      waitingFor = null;
      text('tool ' + m.response.response.behavior);
      setTimeout(() => text('part 2'), Number(process.env.FAKE_TAIL_MS || 300));
      setTimeout(() => say({ type: 'result', subtype: 'success', session_id: 'native-1' }), Number(process.env.FAKE_TAIL_MS || 300) + 100);
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
`;

/** A fake `codex exec`: reads the prompt from stdin, then prints JSONL events. */
const FAKE_CODEX = `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  say({ type: 'thread.started', thread_id: 'thread-1' });
  setTimeout(() => say({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'echo ' + prompt.trim() + ' ' + process.argv.slice(2).join(' ') } }), Number(process.env.FAKE_DELAY_MS || 50));
  setTimeout(() => { say({ type: 'turn.completed', usage: {} }); process.exit(0); }, Number(process.env.FAKE_DELAY_MS || 50) + 50);
});
`;

/**
 * A stand-in for the server process: it launches the relayed unit, attaches,
 * sends one user message, says READY, and then waits to be killed.
 */
const SERVER_CLIENT = `
import { attachRelayedProcess, launchRelayUnit } from ${JSON.stringify(RELAY_CLIENT)};
const [unitName, logPath, command, cwd] = process.argv.slice(2);
if (!launchRelayUnit({ unitName, logPath, command, args: [], cwd, env: process.env, protocol: 'claude' })) process.exit(3);
const child = attachRelayedProcess({ unitName, logPath });
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\\n');
child.stdout.on('data', (chunk) => { if (String(chunk).includes('part 1')) console.log('READY'); });
setInterval(() => {}, 1000);
`;

async function withScratchEnvironment(
  runTest: (ctx: { root: string; writeScript: (name: string, content: string) => string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'relayed-turns-test-'));
  const prevDbPath = process.env.DATABASE_PATH;
  const prevTurnsDir = process.env.CLI_TURNS_DIR;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'test.db');
  process.env.CLI_TURNS_DIR = path.join(root, 'turns');
  await initializeDatabase();
  userDb.createUser('test-user', 'hash');

  const writeScript = (name: string, content: string): string => {
    const file = path.join(root, name);
    writeFileSync(file, content, { mode: 0o755 });
    chmodSync(file, 0o755);
    return file;
  };

  try {
    await runTest({ root, writeScript });
  } finally {
    closeConnection();
    if (prevDbPath) process.env.DATABASE_PATH = prevDbPath;
    else delete process.env.DATABASE_PATH;
    if (prevTurnsDir) process.env.CLI_TURNS_DIR = prevTurnsDir;
    else delete process.env.CLI_TURNS_DIR;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Records a Claude turn the way spawnRelayedTurn does, then drives it from a
 * separate "server" process that is SIGKILLed once the turn is under way, the
 * way a restart takes the server down mid-turn.
 */
async function startTurnThenKillServer(root: string, fakeClaude: string, sessionId: string): Promise<{ unitName: string; logPath: string }> {
  const unitName = `cli-turn-test-${process.pid}-${Date.now()}`;
  const logPath = getTurnLogPath(unitName);
  runningTurnsDb.recordTurn({ unitName, jobId: null, sessionId, backend: 'claude', logPath });

  const clientPath = path.join(root, `server-client-${Date.now()}.mjs`);
  writeFileSync(clientPath, SERVER_CLIENT);
  const server = spawn(process.execPath, [clientPath, unitName, logPath, fakeClaude, root], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  await eventually(() => output.includes('READY'), 'the turn to start', 15_000);
  server.kill('SIGKILL');
  await new Promise((resolve) => server.once('exit', resolve));
  return { unitName, logPath };
}

test('a relayed Claude turn survives a server kill: the relay answers the pending permission and the CLI finishes the turn', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
    const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-kill');

    await eventually(() => readRelayExit(logPath) !== null, 'the CLI to exit on its own');
    assert.deepEqual(readRelayExit(logPath), { code: 0, signal: null });
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /tool deny/, 'the orphaned permission request was denied');
    assert.match(log, /part 2/);
    assert.match(log, /"type":"result"/);
    await eventually(() => !isTurnAlive(unitName), 'the unit to be gone');
  });
});

test('reattach after a restart streams a live Claude turn through the Claude line parser', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    process.env.FAKE_TAIL_MS = '1500';
    try {
      const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
      registerBackendLineParser('claude', createClaudeTurnLineParser((raw, sessionId) => {
        const message = raw as { type: string; message?: { content?: Array<{ text?: string }> } };
        if (message.type !== 'assistant') return [];
        return [{ kind: 'text', role: 'assistant', content: message.message?.content?.[0]?.text, sessionId } as NormalizedMessage];
      }));

      const { unitName } = await startTurnThenKillServer(root, fakeClaude, 'session-reattach');
      assert.ok(isTurnAlive(unitName), 'still running after the server died');

      const received: NormalizedMessage[] = [];
      const writer = { send: (msg: NormalizedMessage) => received.push(msg) };
      let completion: { exitCode: number } | null = null;
      await reattachActiveTurns({
        chatRunRegistry: {
          startRun: () => ({ writer: writer as never }),
          getRun: () => ({ writer: writer as never }),
          completeRunIfCurrent: (_run, done) => { completion = done; },
        },
      });

      await eventually(() => completion !== null, 'the reattached turn to complete');
      assert.equal(completion!.exitCode, 0);
      const texts = received.map((msg) => msg.content);
      assert.ok(texts.includes('part 2'), `streamed after reattach: ${JSON.stringify(texts)}`);
      assert.ok(received.every((msg) => msg.sessionId === 'session-reattach'));
      assert.equal(runningTurnsDb.getTurn(unitName)?.exit_code, 0);
    } finally {
      delete process.env.FAKE_TAIL_MS;
    }
  });
});

test('a Claude turn that finished while the server was down is finalized on startup', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
    const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-down');
    await eventually(() => readRelayExit(logPath) !== null && !isTurnAlive(unitName), 'the turn to end while down');

    const finalized: Array<{ unit: string; exitCode: number }> = [];
    await reattachActiveTurns({
      chatRunRegistry: { startRun: () => null, completeRunIfCurrent: () => {} },
      onTurnCompleted: (turn, exitCode) => finalized.push({ unit: turn.unit_name, exitCode }),
    });
    assert.deepEqual(finalized, [{ unit: unitName, exitCode: 0 }]);
    const row = runningTurnsDb.getTurn(unitName);
    assert.equal(row?.status, 'completed');
    assert.equal(row?.exit_code, 0);
  });
});

test('a relayed Claude process is driven like a child: permission round trip, result, stdin close, exit', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
    const child = spawnRelayedTurn({ command: fakeClaude, args: [], cwd: root, sessionId: 'session-live', backend: 'claude', protocol: 'claude' });
    assert.ok(child);

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk;
      if (out.includes('"request_id":"req-1"') && !out.includes('tool allow')) {
        child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow' } } })}\n`);
      }
      if (out.includes('"type":"result"')) child.stdin.end();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code: number | null) => resolve(code)));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);

    assert.equal(await exited, 0);
    assert.match(out, /tool allow/);
    await eventually(() => runningTurnsDb.getTurn(child.unitName)?.status === 'completed', 'the turn row to complete');
    assert.equal(runningTurnsDb.getTurn(child.unitName)?.exit_code, 0);
  });
});

test('superseding still retires the old process: by its unit when driven here, and a reattached one by session', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);

    // Driven by this server: what retireSessionProcess does (close stdin, then kill).
    process.env.FAKE_PID_FILE = path.join(root, 'driven.pid');
    const driven = spawnRelayedTurn({ command: fakeClaude, args: [], cwd: root, sessionId: 'session-sup', backend: 'claude', protocol: 'claude' });
    assert.ok(driven);
    await eventually(() => existsSync(process.env.FAKE_PID_FILE!), 'the driven CLI to start');
    const drivenPid = Number(readFileSync(process.env.FAKE_PID_FILE!, 'utf8'));
    const exited = new Promise((resolve) => driven.once('exit', resolve));
    driven.kill('SIGTERM');
    await exited;
    await eventually(() => !pidAlive(drivenPid), 'the driven CLI to be gone');

    // Left by a previous server instance: a new turn retires it by session.
    process.env.FAKE_PID_FILE = path.join(root, 'left.pid');
    const { unitName } = await startTurnThenKillServer(root, fakeClaude, 'session-sup');
    delete process.env.FAKE_PID_FILE;
    const leftPid = Number(readFileSync(path.join(root, 'left.pid'), 'utf8'));
    assert.ok(pidAlive(leftPid));
    assert.equal(await retireDetachedSessionTurns('session-sup', 'claude'), 1);
    await eventually(() => !pidAlive(leftPid), 'the reattached CLI to be gone');
    assert.equal(isTurnAlive(unitName), false);
    assert.equal(runningTurnsDb.getTurn(unitName)?.status, 'completed');
  });
});

test('the Codex wrapper runs the CLI in a unit that outlives the wrapper', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeCodex = writeScript('fake-codex.js', FAKE_CODEX);

    // An ordinary run, as the Codex SDK drives it.
    const exec = prepareDetachedExec({ command: fakeCodex, sessionId: 'session-codex', backend: 'codex' });
    assert.ok(exec);
    const run = spawn(exec.executable, ['exec', '--json'], { env: exec.env, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    run.stdout.on('data', (chunk) => { out += chunk; });
    run.stdin.end('hello codex');
    const code = await new Promise((resolve) => run.once('exit', resolve));
    exec.complete();
    assert.equal(code, 0);
    assert.match(out, /echo hello codex exec --json/);
    assert.equal(runningTurnsDb.getTurn(exec.unitName)?.exit_code, 0);

    // The wrapper is killed (the server going down): the CLI finishes anyway.
    const exec2 = prepareDetachedExec({ command: fakeCodex, sessionId: 'session-codex', backend: 'codex' });
    assert.ok(exec2);
    const run2 = spawn(exec2.executable, ['exec'], { env: { ...exec2.env, FAKE_DELAY_MS: '1500' }, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
    run2.stdin.end('second');
    const logPath = getTurnLogPath(exec2.unitName);
    await eventually(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('thread.started'), 'the second turn to start');
    run2.kill('SIGTERM');
    await eventually(() => readRelayExit(logPath) !== null, 'the CLI to finish without its wrapper');
    assert.match(readFileSync(logPath, 'utf8'), /echo second/);
    assert.deepEqual(readRelayExit(logPath), { code: 0, signal: null });
  });
});

test('without systemd-run nothing is relayed: the runtimes spawn their CLIs directly', async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    process.env.CLI_DISABLE_SYSTEMD_RUN = '1';
    resetSystemdRunCache();
    try {
      const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
      assert.equal(spawnRelayedTurn({ command: fakeClaude, args: [], cwd: root, sessionId: 's', backend: 'claude', protocol: 'claude' }), null);
      assert.equal(prepareDetachedExec({ command: fakeClaude, sessionId: 's', backend: 'codex' }), null);
      assert.equal(runningTurnsDb.listRunningTurns().length, 0, 'no turn recorded');

      // The Claude runtime's spawn falls back to an ordinary child process.
      const child = spawnDetachableClaudeProcess({ command: fakeClaude, args: [], cwd: root, env: process.env }, undefined, { sessionId: 's' }) as ChildProcessWithoutNullStreams;
      assert.equal(typeof child.pid, 'number');
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk;
        if (out.includes('part 1')) child.stdin.end();
      });
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
      const code = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(code, 0);
    } finally {
      delete process.env.CLI_DISABLE_SYSTEMD_RUN;
      resetSystemdRunCache();
    }
  });
});
