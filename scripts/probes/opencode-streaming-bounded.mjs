#!/usr/bin/env node
/**
 * Independent, bounded probe for the OpenCode live-delta bridge.
 *
 * It does not use a remote model. It exercises:
 *  A. the real installed `opencode serve` event envelope and subscription
 *     lifecycle, with isolated HOME/XDG dirs and explicit deadlines;
 *  B. the real bridge process (`opencode-bridge.ts`) plus the real turn line
 *     parser against a local fake event server that emits the exact
 *     `{ id, type, properties }` frames the installed OpenCode 1.19.4 binary
 *     defines for `message.part.delta` / `server.connected`.
 *
 * Run with:
 *   npx tsx --tsconfig server/tsconfig.json scripts/probes/opencode-streaming-bounded.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenCodeTurnLineParser } from '../../server/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from '../../server/modules/providers/list/opencode/opencode-sessions.provider.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bridgePath = path.join(repoRoot, 'server/modules/providers/list/opencode/opencode-bridge.ts');
const tsconfigPath = path.join(repoRoot, 'server/tsconfig.json');
const sessionsProvider = new OpenCodeSessionsProvider();

const results = [];
const record = (name, detail) => {
  results.push({ name, detail });
  console.log(`PASS ${name}: ${detail}`);
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
};

const waitForExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
    return;
  }
  const timer = setTimeout(() => {
    child.removeListener('exit', onExit);
    resolve({ code: null, signal: null, timedOut: true });
  }, timeoutMs);
  const onExit = (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, timedOut: false });
  };
  child.once('exit', onExit);
});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killTree = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
  await waitForExit(child, 2000);
};

// ---------------------------------------------------------------------------
// A. Real installed OpenCode server: envelope + subscription lifecycle.
// ---------------------------------------------------------------------------
async function probeRealServer() {
  const opencode = process.env.OPENCODE_BIN || 'opencode';
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-probe-real-'));
  const dirs = {
    home: path.join(root, 'home'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    cache: path.join(root, 'cache'),
    state: path.join(root, 'state'),
    work: path.join(root, 'work'),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
  };
  const child = spawn(opencode, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: dirs.work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const controller = new AbortController();
  try {
    await waitFor(() => stdout.includes('listening on'), 15000, 'real opencode serve listening');
    const response = await fetch(`http://127.0.0.1:${port}/event?directory=${encodeURIComponent(dirs.work)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(response.ok, true, `real /event HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = null;
    const deadline = Date.now() + 5000;
    while (!event && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (parsed.type === 'server.connected') {
          event = parsed;
          break;
        }
      }
    }
    assert.ok(event, 'real server.connected event within 5s');
    assert.equal(typeof event.id, 'string');
    assert.equal(event.type, 'server.connected');
    assert.equal(typeof event.properties, 'object');
    record('real-server-envelope', `id=${event.id} type=${event.type} properties=${JSON.stringify(event.properties)}`);

    controller.abort();
    try { await reader.cancel(); } catch {}
    child.kill('SIGTERM');
    const exit = await waitForExit(child, 5000);
    assert.equal(exit.timedOut, false, 'real serve exited after abort/kill');
    record('real-server-lifecycle', `serve exited code=${exit.code} signal=${exit.signal}`);
  } finally {
    controller.abort();
    await killTree(child);
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// B. Real bridge + real parser against a local fake event server.
// ---------------------------------------------------------------------------
const FAKE_OPENCODE = String.raw`
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
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const scenario = process.env.OC_PROBE_SCENARIO;
if (args[0] === 'serve') {
  if (scenario === 'fallback') process.exit(1);
  const port = Number(args[args.indexOf('--port') + 1]);
  if (process.env.OC_PROBE_SERVE_PID) fs.writeFileSync(process.env.OC_PROBE_SERVE_PID, String(process.pid));
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/event')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const frame = (id, type, properties) => res.write('data: ' + JSON.stringify({ id, type, properties }) + '\n\n');
    frame('evt_connected', 'server.connected', {});
    if (scenario === 'incremental') {
      frame('evt_d1', 'message.part.delta', { sessionID: 'ses_A', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hel' });
      frame('evt_other', 'message.part.delta', { sessionID: 'ses_B', messageID: 'msg_2', partID: 'prt_2', field: 'text', delta: 'LEAK' });
      frame('evt_d1', 'message.part.delta', { sessionID: 'ses_A', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hel' });
      frame('evt_d2', 'message.part.delta', { sessionID: 'ses_A', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'lo' });
      frame('evt_done', 'message.part.updated', { sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text', text: 'Hello' } });
      frame('evt_idle', 'session.idle', { sessionID: 'ses_A' });
      return;
    }
    if (scenario === 'disconnect') {
      setTimeout(() => res.destroy(), 50);
      return;
    }
    // stall: server.connected only, connection stays open.
  });
  server.listen(port, '127.0.0.1');
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  if (process.env.OC_PROBE_RUN_PID) fs.writeFileSync(process.env.OC_PROBE_RUN_PID, String(process.pid));
  if (scenario === 'incremental') {
    waitForFile(process.env.OC_PROBE_DELTAS_SEEN, 5000);
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text', text: 'Hello' } });
    say({ type: 'step_finish', sessionID: 'ses_A' });
  } else if (scenario === 'disconnect') {
    waitForFile(process.env.OC_PROBE_RESET_SEEN, 5000);
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text', text: 'Hello' } });
    say({ type: 'step_finish', sessionID: 'ses_A' });
  } else if (scenario === 'fallback') {
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text' }, delta: 'Hel' });
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text' }, delta: 'lo' });
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text', text: 'Hello' } });
    say({ type: 'step_finish', sessionID: 'ses_A' });
  } else {
    // stall: complete after a short bounded delay; the bridge must not wait on SSE.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    say({ type: 'text', sessionID: 'ses_A', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_A', type: 'text', text: 'Hello' } });
    say({ type: 'step_finish', sessionID: 'ses_A' });
  }
}
`;

async function makeFakeBin(root) {
  const binDir = path.join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, FAKE_OPENCODE, 'utf8');
  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
  return binDir;
}

async function runBridgeScenario(scenario, { cancelAfterConnected = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `oc-probe-${scenario}-`));
  const binDir = await makeFakeBin(root);
  const markers = {
    deltasSeen: path.join(root, 'deltas-seen'),
    resetSeen: path.join(root, 'reset-seen'),
    servePid: path.join(root, 'serve.pid'),
    runPid: path.join(root, 'run.pid'),
  };
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    OC_PROBE_SCENARIO: scenario,
    OC_PROBE_DELTAS_SEEN: markers.deltasSeen,
    OC_PROBE_RESET_SEEN: markers.resetSeen,
    OC_PROBE_SERVE_PID: markers.servePid,
    OC_PROBE_RUN_PID: markers.runPid,
    CLI_DISABLE_SYSTEMD_RUN: '1',
    TSX_TSCONFIG_PATH: tsconfigPath,
  };
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), bridgePath, '--', 'run', '--session', 'ses_A', '--dir', root, 'Hi'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rawLines = [];
  const messages = [];
  const parser = createOpenCodeTurnLineParser((raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId));
  const writer = {
    send(message) { messages.push(message); },
    setSessionId() {},
    getSessionId: () => 'ses_A',
  };
  let stdoutBuffer = '';
  let stderr = '';
  const lineTimes = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      rawLines.push(line);
      lineTimes.push({ line, at: Date.now() });
      parser(line, writer, 'app-session');
      if (line.includes('"delta":"lo"')) void writeFile(markers.deltasSeen, '1');
      if (line.includes('"type":"stream_reset"')) void writeFile(markers.resetSeen, '1');
      newline = stdoutBuffer.indexOf('\n');
    }
  });

  const startedAt = Date.now();
  if (cancelAfterConnected) {
    await waitFor(async () => {
      try { await readFile(markers.servePid); return true; } catch { return false; }
    }, 5000, 'fake serve pid');
    await waitFor(async () => {
      try { await readFile(markers.runPid); return true; } catch { return false; }
    }, 5000, 'fake run pid');
    child.kill('SIGTERM');
  }
  const exit = await waitForExit(child, 12000);
  const elapsedMs = Date.now() - startedAt;
  if (exit.timedOut) {
    await killTree(child);
    throw new Error(`${scenario}: bridge did not exit within 12s`);
  }
  const servePid = Number(await readFile(markers.servePid, 'utf8').catch(() => '0'));
  const runPid = Number(await readFile(markers.runPid, 'utf8').catch(() => '0'));
  await rm(root, { recursive: true, force: true });
  return { scenario, rawLines, messages, lineTimes, exit, elapsedMs, servePid, runPid, stderr };
}

async function probeIncremental() {
  const result = await runBridgeScenario('incremental');
  const deltas = result.messages.filter((message) => message.kind === 'stream_delta');
  assert.deepEqual(deltas.map((message) => message.content), ['Hel', 'lo'], 'incremental deltas');
  assert.equal(result.messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0, 'no duplicate completed text');
  assert.equal(result.exit.code, 0, 'bridge exit code');
  assert.equal(result.rawLines.some((line) => line.includes('LEAK')), false, 'other session filtered');
  const deltaLines = result.lineTimes.filter(({ line }) => line.includes('"delta"'));
  const completionLine = result.lineTimes.find(({ line }) => line.includes('"text":"Hello"'));
  assert.ok(deltaLines.length === 2, `expected 2 delta lines, got ${deltaLines.length}`);
  assert.ok(completionLine, 'completion line present');
  assert.ok(deltaLines.every(({ at }) => at <= completionLine.at), 'deltas before completion');
  assert.equal(result.servePid > 0 && isAlive(result.servePid), false, 'serve child cleaned up');
  record('incremental', `deltas=${JSON.stringify(deltas.map((m) => m.content))} rawDeltaLines=${deltaLines.length} servePid=${result.servePid} alive=${isAlive(result.servePid)}`);
}

async function probeFallback() {
  const result = await runBridgeScenario('fallback');
  const deltas = result.messages.filter((message) => message.kind === 'stream_delta');
  assert.deepEqual(deltas.map((message) => message.content), ['Hel', 'lo'], 'fallback flat deltas');
  assert.equal(result.messages.filter((message) => message.kind === 'text' && message.content === 'Hello').length, 0, 'no duplicate completed text');
  assert.equal(result.exit.code, 0, 'bridge exit code');
  record('stdout-fallback', `deltas=${JSON.stringify(deltas.map((m) => m.content))} completedTextDuplicates=0`);
}

async function probeDisconnect() {
  const result = await runBridgeScenario('disconnect');
  assert.equal(result.rawLines.some((line) => line.includes('"type":"stream_reset"')), true, 'stream_reset emitted');
  const texts = result.messages.filter((message) => message.kind === 'text');
  assert.deepEqual(texts.map((message) => message.content), ['Hello'], 'completed text once');
  assert.equal(result.exit.code, 0, 'bridge exit code');
  record('disconnect-fallback', `stream_reset=1 completedText=${JSON.stringify(texts.map((m) => m.content))}`);
}

async function probeStallBounded() {
  const result = await runBridgeScenario('stall');
  assert.ok(result.elapsedMs < 8000, `stall bridge exited in ${result.elapsedMs}ms`);
  assert.equal(result.servePid > 0 && isAlive(result.servePid), false, 'stall serve child cleaned up');
  record('stall-bounded', `elapsedMs=${result.elapsedMs} servePid=${result.servePid} alive=${isAlive(result.servePid)}`);
}

async function probeCancellation() {
  const result = await runBridgeScenario('stall', { cancelAfterConnected: true });
  assert.ok(result.elapsedMs < 8000, `cancelled bridge exited in ${result.elapsedMs}ms`);
  await waitFor(() => !isAlive(result.servePid), 2000, 'cancelled serve child cleanup');
  assert.ok(result.runPid > 0, 'cancelled run child was started');
  await waitFor(() => !isAlive(result.runPid), 2000, 'cancelled run child cleanup');
  record('cancellation-cleanup', `elapsedMs=${result.elapsedMs} serveAlive=${isAlive(result.servePid)} runAlive=${isAlive(result.runPid)}`);
}

async function main() {
  const startedAt = Date.now();
  await probeRealServer();
  await probeIncremental();
  await probeFallback();
  await probeDisconnect();
  await probeStallBounded();
  await probeCancellation();
  console.log(`\n${results.length} probes passed in ${Date.now() - startedAt}ms`);
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  process.exit(1);
});
