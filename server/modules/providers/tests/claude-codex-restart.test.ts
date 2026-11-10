import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, runningTurnsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { createClaudeTurnLineParser, listClaudeSDKBackgroundWork, spawnDetachableClaudeProcess } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { createCodexTurnLineParser } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import {
  abortTurn,
  getTurnLogPath,
  isSystemdRunAvailable,
  isTurnAlive,
  prepareDetachedExec,
  reattachActiveTurns,
  registerBackendLineParser,
  resetSystemdRunCache,
  retireDetachedSessionTurns,
  readDeliveredOffset,
  readRelayExit,
  spawnRelayedTurn,
  tailLogFile,
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
let sid = 'native-1';
const text = (t) => say({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
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
      if (process.env.FAKE_QUIET_TAIL) sid = undefined;
      text('tool ' + m.response.response.behavior);
      setTimeout(() => text('part 2'), Number(process.env.FAKE_TAIL_MS || 300));
      setTimeout(() => say({ type: 'result', subtype: 'success', session_id: sid }), Number(process.env.FAKE_TAIL_MS || 300) + 100);
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
`;

/** A fake `claude` that asks for a permission the moment it starts, before any client could have connected. */
const FAKE_CLAUDE_EARLY_ASK = `#!/usr/bin/env node
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
say({ type: 'control_request', request_id: 'req-0', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_response' && m.response.request_id === 'req-0') {
      say({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'early ' + m.response.response.behavior }] } });
      say({ type: 'result', subtype: 'success', session_id: 'native-1' });
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
`;

/**
 * A fake `claude` that starts a background task, reports `result`, and only
 * later (FAKE_BG_MS) reports the task done and a follow-up turn. Like the real
 * CLI it exits when stdin closes, so closing stdin early loses the follow-up.
 */
const FAKE_CLAUDE_BACKGROUND = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const text = (t) => say({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
process.stdin.once('data', () => {
  say({ type: 'system', subtype: 'init', session_id: 'native-1' });
  say({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'sleep 3', run_in_background: true } }] } });
  say({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tu-1', session_id: 'native-1' });
  text('part 1');
  say({ type: 'result', subtype: 'success', session_id: 'native-1' });
  setTimeout(() => {
    say({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', session_id: 'native-1' });
    text('background done');
    say({ type: 'result', subtype: 'success', session_id: 'native-1' });
  }, Number(process.env.FAKE_BG_MS || 3000));
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

/** Registers the Claude line parser with a normalizer that keeps assistant text only. */
function registerTextParser(): void {
  registerBackendLineParser('claude', () => createClaudeTurnLineParser((raw, sessionId) => {
    const message = raw as { type: string; message?: { content?: Array<{ text?: string }> } };
    if (message.type !== 'assistant') return [];
    return [{ kind: 'text', role: 'assistant', content: message.message?.content?.[0]?.text, sessionId } as NormalizedMessage];
  }));
}

async function withScratchEnvironment(
  runTest: (ctx: { root: string; writeScript: (name: string, content: string) => string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'relayed-turns-test-'));
  const prevDbPath = process.env.DATABASE_PATH;
  const prevTurnsDir = process.env.CLI_TURNS_DIR;
  const prevHome = process.env.HOME;
  closeConnection();
  // Never the real ~/.cloudcli: the relayed units inherit this HOME too.
  process.env.HOME = path.join(root, 'home');
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
    if (prevHome) process.env.HOME = prevHome;
    else delete process.env.HOME;
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
  // Past one offset save (250 ms), so what the server delivered is recorded.
  await new Promise((resolve) => setTimeout(resolve, 400));
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
    await eventually(async () => !(await isTurnAlive(unitName)), 'the unit to be gone');
  });
});

test('reattach after a restart streams a live Claude turn through the Claude line parser', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    process.env.FAKE_TAIL_MS = '1500';
    try {
      const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
      registerTextParser();

      const { unitName } = await startTurnThenKillServer(root, fakeClaude, 'session-reattach');
      assert.ok(await isTurnAlive(unitName), 'still running after the server died');

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
      assert.ok(!texts.includes('part 1'), `output the old server delivered is not replayed: ${JSON.stringify(texts)}`);
      assert.ok(received.every((msg) => msg.sessionId === 'native-1'));
      const created = received.find((msg) => msg.kind === 'session_created') as { newSessionId?: string } | undefined;
      assert.equal(created?.newSessionId, 'native-1', 'a brand-new session learns its provider id after reattach');
      assert.equal(runningTurnsDb.getTurn(unitName)?.exit_code, 0);
    } finally {
      delete process.env.FAKE_TAIL_MS;
    }
  });
});

test('a Claude turn that finished while the server was down is finalized on startup', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
    registerTextParser();
    sessionsDb.createAppSession('session-down', 'claude', root);
    const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-down');
    await eventually(async () => readRelayExit(logPath) !== null && !(await isTurnAlive(unitName)), 'the turn to end while down');

    const finalized: Array<{ unit: string; exitCode: number }> = [];
    await reattachActiveTurns({
      chatRunRegistry: { startRun: () => null, completeRunIfCurrent: () => {} },
      onTurnCompleted: (turn, exitCode) => finalized.push({ unit: turn.unit_name, exitCode }),
    });
    assert.deepEqual(finalized, [{ unit: unitName, exitCode: 0 }]);
    const row = runningTurnsDb.getTurn(unitName);
    assert.equal(row?.status, 'completed');
    assert.equal(row?.exit_code, 0);
    assert.equal(sessionsDb.getSessionById('session-down')?.provider_session_id, 'native-1', 'the provider session id is recorded');
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

/**
 * A server that launches the unit but attaches only once the CLI's request is
 * already in the log, as a slow server start would. It answers `allow` and
 * prints what the CLI reported.
 */
const LATE_ATTACH_CLIENT = `
import { existsSync, readFileSync } from 'node:fs';
import { attachRelayedProcess, launchRelayUnit } from ${JSON.stringify(RELAY_CLIENT)};
const [unitName, logPath, command, cwd] = process.argv.slice(2);
if (!launchRelayUnit({ unitName, logPath, command, args: [], cwd, env: process.env, protocol: 'claude' })) process.exit(3);
while (!(existsSync(logPath) && readFileSync(logPath, 'utf8').includes('req-0'))) await new Promise((r) => setTimeout(r, 20));
await new Promise((r) => setTimeout(r, 500));
const child = attachRelayedProcess({ unitName, logPath });
let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk;
  if (out.includes('"request_id":"req-0"') && !out.includes('early ')) {
    child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-0', response: { behavior: 'allow' } } }) + '\\n');
  }
  if (out.includes('"type":"result"')) child.stdin.end();
});
child.once('exit', (code) => { console.log(JSON.stringify({ code, out })); process.exit(0); });
`;

test('a permission asked before the server has connected waits for the server instead of being denied', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude-early.js', FAKE_CLAUDE_EARLY_ASK);
    const unitName = `cli-turn-test-${process.pid}-${Date.now()}`;
    const logPath = getTurnLogPath(unitName);
    const clientPath = path.join(root, 'late-attach-client.mjs');
    writeFileSync(clientPath, LATE_ATTACH_CLIENT);
    const server = spawn(process.execPath, [clientPath, unitName, logPath, fakeClaude, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    server.stdout.on('data', (chunk) => { output += chunk; });
    await new Promise((resolve) => server.once('exit', resolve));

    const { code, out } = JSON.parse(output.trim().split('\n').pop()!) as { code: number; out: string };
    assert.equal(code, 0);
    assert.match(out, /early allow/, 'the server answered the early request');
    assert.doesNotMatch(out, /early deny/, 'the relay did not answer it for a server that had not connected yet');
  });
});

test('a turn held open for background work keeps stdin open after the server dies, until the work reports back', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude-bg.js', FAKE_CLAUDE_BACKGROUND);
    process.env.FAKE_PID_FILE = path.join(root, 'bg.pid');
    process.env.FAKE_BG_MS = '3000';
    try {
      const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-bg');
      const pid = Number(readFileSync(process.env.FAKE_PID_FILE, 'utf8'));

      // Well past the relay's own reaction time: an orphaned turn without the hold would have exited by now.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.ok(pidAlive(pid), 'the CLI still has its stdin while the background task runs');
      assert.equal(readRelayExit(logPath), null);

      await eventually(() => readRelayExit(logPath) !== null, 'the CLI to exit once the background work is done', 15_000);
      assert.deepEqual(readRelayExit(logPath), { code: 0, signal: null });
      assert.match(readFileSync(logPath, 'utf8'), /background done/, 'the follow-up turn was not lost');
      await eventually(async () => !(await isTurnAlive(unitName)), 'the unit to be gone');
    } finally {
      delete process.env.FAKE_PID_FILE;
      delete process.env.FAKE_BG_MS;
    }
  });
});

test('a brand-new session reattached past its init keeps its provider id: the delivered prefix primes the parser', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    process.env.FAKE_QUIET_TAIL = '1';
    try {
      const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
      registerTextParser();
      sessionsDb.createAppSession('session-prime', 'claude', root);
      const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-prime');
      const delivered = readFileSync(logPath, 'utf8').slice(0, readDeliveredOffset(logPath));
      assert.match(delivered, /"session_id":"native-1"/, 'the session id was delivered before the kill');

      await reattachActiveTurns({}); // the real chat run registry
      await eventually(() => runningTurnsDb.getTurn(unitName)?.status === 'completed', 'the reattached turn to end');
      assert.doesNotMatch(readFileSync(logPath, 'utf8').slice(delivered.length), /native-1/, 'nothing after the offset names the session');
      assert.equal(sessionsDb.getSessionById('session-prime')?.provider_session_id, 'native-1', 'the provider session id is recorded');
      assert.equal(chatRunRegistry.getRun('session-prime')?.status, 'completed');
    } finally {
      delete process.env.FAKE_QUIET_TAIL;
    }
  });
});

test('a reattached Claude turn held for background work is complete for the client at once, and its tasks are tracked until the hold ends', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    process.env.FAKE_BG_MS = '4000';
    try {
      const fakeClaude = writeScript('fake-claude-bg.js', FAKE_CLAUDE_BACKGROUND);
      registerTextParser();
      sessionsDb.createAppSession('session-hold', 'claude', root);
      const { unitName, logPath } = await startTurnThenKillServer(root, fakeClaude, 'session-hold');
      assert.match(readFileSync(logPath, 'utf8').slice(0, readDeliveredOffset(logPath)), /"type":"result"/, 'the result was delivered before the kill');

      await reattachActiveTurns({}); // the real chat run registry
      assert.equal(chatRunRegistry.getRun('session-hold')?.status, 'completed', 'the run is complete for the client');
      assert.ok(await isTurnAlive(unitName), 'while the unit is still held');
      const held = listClaudeSDKBackgroundWork().find((work) => work.sessionId === 'session-hold');
      assert.deepEqual(held?.tasks.map((task) => task.taskId), ['task-1'], 'the background task is tracked');

      await eventually(() => runningTurnsDb.getTurn(unitName)?.status === 'completed', 'the hold to end', 15_000);
      assert.equal(listClaudeSDKBackgroundWork().find((work) => work.sessionId === 'session-hold'), undefined, 'cleared once the unit is gone');
    } finally {
      delete process.env.FAKE_BG_MS;
    }
  });
});

test('priming from the delivered prefix: Codex recovers its thread id; Claude restores its model and sends no stale budget', () => {
  const sent: NormalizedMessage[] = [];
  let providerId: string | null = null;
  const writer = {
    send: (msg: NormalizedMessage) => sent.push(msg),
    setSessionId: (id: string) => { providerId = id; },
    getSessionId: () => providerId,
  };
  const codex = createCodexTurnLineParser((_raw, sid) => [{ kind: 'text', content: 'x', sessionId: sid } as NormalizedMessage]);
  codex.prime?.([JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' }), '{"type":"item.completed","item":{"type":"agent_message","text":"old"}}'], writer as never);
  codex(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'new' } }), writer as never, 'app-codex');
  assert.equal(providerId, 'thread-9');
  assert.equal((sent.find((msg) => msg.kind === 'session_created') as { newSessionId?: string } | undefined)?.newSessionId, 'thread-9');
  assert.equal(sent.at(-1)?.sessionId, 'thread-9');

  sent.length = 0;
  providerId = null;
  const usage = { input_tokens: 10, output_tokens: 5 };
  const claude = createClaudeTurnLineParser(() => []);
  claude.prime?.([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-9' }),
    JSON.stringify({ type: 'assistant', session_id: 'native-9', message: { role: 'assistant', model: 'claude-x', content: [], usage } }),
  ], writer as never, 'app-claude');
  assert.equal(providerId, 'native-9');
  claude(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'native-9', usage: { input_tokens: 999, output_tokens: 999 } }), writer as never, 'app-claude');
  assert.ok(!sent.some((msg) => msg.kind === 'status' && (msg as { text?: string }).text === 'token_budget'), 'the result\'s summed bill is not published as the context budget');
  assert.equal(sent.filter((msg) => msg.kind === 'complete').length, 1, 'the result completes the turn once');
  claude(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'native-9' }), writer as never, 'app-claude');
  assert.equal(sent.filter((msg) => msg.kind === 'complete').length, 1, 'and only once');
});

test('the log tail decodes a multi-byte character split across read chunks', async () => {
  await withScratchEnvironment(async ({ root }) => {
    const logPath = path.join(root, 'utf8.log');
    // 'é' is two bytes; an odd-length prefix puts one straddling the 64 KiB chunk boundary.
    const first = `${'a'.repeat(64 * 1024 - 1)}é`;
    const second = 'ação 🙂 done';
    writeFileSync(logPath, `${first}\n${second}\n`);
    const lines: string[] = [];
    await tailLogFile(logPath, { isAlive: () => false, onLine: (line) => lines.push(line) });
    assert.deepEqual(lines, [first, second]);
  });
});

test('aborting a session stops every running turn it has, not just the first', { skip: !systemd }, async () => {
  await withScratchEnvironment(async ({ root, writeScript }) => {
    const fakeClaude = writeScript('fake-claude.js', FAKE_CLAUDE);
    const pids: number[] = [];
    for (const name of ['a', 'b']) {
      process.env.FAKE_PID_FILE = path.join(root, `${name}.pid`);
      const { unitName } = await startTurnThenKillServer(root, fakeClaude, 'session-many');
      pids.push(Number(readFileSync(process.env.FAKE_PID_FILE, 'utf8')));
      assert.ok(await isTurnAlive(unitName));
    }
    delete process.env.FAKE_PID_FILE;
    assert.equal(runningTurnsDb.listRunningTurns().filter((turn) => turn.session_id === 'session-many').length, 2);

    assert.equal(abortTurn('session-many'), true);
    await eventually(() => pids.every((pid) => !pidAlive(pid)), 'both CLIs to be stopped');
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
    assert.equal(await isTurnAlive(unitName), false);
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
    await exec.complete();
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
    // The CLI has exited, but its unit can linger for a moment; wait for it to
    // be gone so complete() finalizes the row instead of leaving it running.
    await eventually(async () => !(await isTurnAlive(exec2.unitName)), 'the second unit to be gone');
    await exec2.complete();

    // Superseded while this server still drives it: the new turn stops the old unit.
    const exec3 = prepareDetachedExec({ command: fakeCodex, sessionId: 'session-codex', backend: 'codex' });
    assert.ok(exec3);
    const run3 = spawn(exec3.executable, ['exec'], { env: { ...exec3.env, FAKE_DELAY_MS: '30000' }, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
    run3.stdin.end('third');
    const logPath3 = getTurnLogPath(exec3.unitName);
    await eventually(() => existsSync(logPath3) && readFileSync(logPath3, 'utf8').includes('thread.started'), 'the third turn to start');
    assert.equal(await retireDetachedSessionTurns('session-codex', 'codex'), 0, 'an attached unit is left alone by default');
    assert.equal(await retireDetachedSessionTurns('session-codex', 'codex', { includeAttached: true }), 1);
    await eventually(async () => !(await isTurnAlive(exec3.unitName)), 'the superseded unit to be stopped');
    if (run3.exitCode === null && run3.signalCode === null) await new Promise((resolve) => run3.once('exit', resolve));
    assert.doesNotMatch(readFileSync(logPath3, 'utf8'), /echo third/);
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
