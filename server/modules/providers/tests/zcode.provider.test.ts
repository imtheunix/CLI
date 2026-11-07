import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

import { ZcodeProvider } from '../list/zcode/zcode.provider.js';
import {
  isZcodeProbeHealthy,
  probeZcodeLogin,
  recordZcodeSuccess,
  resetZcodeProbeCache,
} from '../list/zcode/zcode-probe.js';

// ZCode reports reset times in UTC+8; keep the fixture in the future on every run.
const quotaReset = new Date(Math.floor((Date.now() + 7 * 86400_000) / 1000) * 1000);
const quotaResetInChina = new Date(quotaReset.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

const PLAN_ENV = ['ZCODE_TEST_HONORED', 'ZCODE_TEST_EXHAUSTED', 'ZCODE_TEST_FORCE', 'ZCODE_TEST_LOGIN_FAILED', 'ZCODE_TEST_PROBE_HANG'];

async function withCli(run: (root: string, provider: ZcodeProvider) => Promise<void>, env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-'));
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const argsFile = process.env.ZCODE_TEST_ARGS;
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'bin', 'zcode'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ZCODE_TEST_ARGS, JSON.stringify(args));
if (args[1] === 'hang') { setInterval(() => {}, 1000); }
else if (args[0] === 'version') {
  process.stdout.write('ZCode 0.17.1\\n');
}
else if (args[0] === '-p' && args[1] === 'ok') {
  if (process.env.ZCODE_TEST_LOGIN_FAILED) {
    process.stderr.write("[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }\\n");
    process.exit(1);
  }
  if (process.env.ZCODE_TEST_PROBE_HANG) {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\\n');
    process.exit(0);
  }
}
else {
// Like headless ZCode 0.17.1: an unentitled default silently becomes the Coding Plan's full GLM-5.3.
const home = process.env.HOME;
const selection = JSON.parse(fs.readFileSync(home + '/.zcode/v2/provider_config.json', 'utf8')).config.defaultModelSelection;
if (!['low', 'high', 'max'].includes(selection.options?.reasoningLevel)) throw new Error('Invalid ZCode reasoning level');
fs.appendFileSync(home + '/runs.log', selection.providerId + '/' + selection.modelId + '\\n');
const honored = (process.env.ZCODE_TEST_HONORED || 'account:zai-individual-coding-plan').split(',');
let [providerId, modelId] = honored.includes(selection.providerId) && selection.options && selection.options.reasoningLevel
  ? [selection.providerId, selection.modelId] : ['account:zai-individual-coding-plan', 'GLM-5.3'];
if (process.env.ZCODE_TEST_FORCE) [providerId, modelId] = process.env.ZCODE_TEST_FORCE.split('|');
const report = {type:'session.updated',sessionId:'sess_native_zcode',payload:{messageCount:1,providerId,modelId,iteration:0}};
if (args[1] === 'live') {
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  send(report);
  send({type:'turn.started',sessionId:'sess_native_zcode',payload:{input:'live'}});
  send({type:'model.streaming',sessionId:'sess_native_zcode',payload:{kind:'text_delta',delta:'Working'}});
  send({type:'tool.updated',sessionId:'sess_native_zcode',payload:{kind:'scheduled',toolCallId:'call-1',toolName:'bash',input:{command:'pwd'}}});
  setTimeout(() => {
    send({type:'tool.updated',sessionId:'sess_native_zcode',payload:{kind:'progress',toolCallId:'call-1',elapsedMs:100}});
    send({type:'tool.updated',sessionId:'sess_native_zcode',payload:{kind:'result',toolCallId:'call-1',result:{output:'/tmp'},duration:100}});
    send({type:'model.streaming',sessionId:'sess_native_zcode',payload:{kind:'text_delta',delta:'Done'}});
    send({type:'turn.completed',sessionId:'sess_native_zcode',payload:{resultType:'success',response:'Done'}});
  }, 500);
} else {
if ((process.env.ZCODE_TEST_EXHAUSTED || '').split(',').includes(providerId)) {
  process.stdout.write(JSON.stringify(report) + '\\n');
  process.stderr.write('ProviderBusinessError: Weekly/Monthly Limit Exhausted. Your limit will reset at ${quotaResetInChina}\\n');
  process.stdout.write(JSON.stringify({type:'turn.failed',sessionId:'sess_native_zcode',payload:{error:{message:'Weekly/Monthly Limit Exhausted'}}}) + '\\n');
  process.exit(1);
}
const events = [
 report,
 {event:'init',conversation_id:'sess_native_zcode',init:{model:'GLM-5.3-Flash'}},
 {event:'step_update',step_update:{step_index:2,step_type:'tool',state:'ACTIVE',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'pwd'}}}},
 {event:'step_update',step_update:{step_index:2,step_type:'tool',state:'DONE',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'pwd'},output:'/tmp'}}},
 {event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'Hello'}},
 {event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'DONE',text_delta:' from ZCode'}},
 {event:'result',result:{conversation_id:'sess_native_zcode',status:args[1] === 'fail' ? 'ERROR' : 'SUCCESS',response:'Hello from ZCode'}}
];
const text = events.map(e => JSON.stringify(e)).join('\\n');
process.stdout.write(text.slice(0, 23));
setTimeout(() => process.stdout.write(text.slice(23)), 10);
}
}
`, { mode: 0o700 });
  process.env.HOME = root;
  process.env.PATH = path.join(root, 'bin') + path.delimiter + previousPath;
  process.env.ZCODE_TEST_ARGS = path.join(root, 'args.json');
  for (const key of PLAN_ENV) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  try { await run(root, new ZcodeProvider()); }
  finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (argsFile === undefined) delete process.env.ZCODE_TEST_ARGS; else process.env.ZCODE_TEST_ARGS = argsFile;
    for (const key of PLAN_ENV) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
}

async function runs(root: string): Promise<string[]> {
  return (await readFile(path.join(root, 'runs.log'), 'utf8')).split('\n').filter(Boolean);
}

async function planState(root: string) {
  return JSON.parse(await readFile(path.join(root, '.cloudcli', 'zcode', 'provider-state.json'), 'utf8'));
}

function context(nativeId: string | null): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (_id, model) => model ?? undefined,
    getProviderModels: async () => new ZcodeProvider().models.getSupportedModels(),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

test('zcode launches, streams split NDJSON, configures GLM-5.3-Flash, persists history and resumes', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    const nativeIds: string[] = [];
    const writer = {
      send: (message: NormalizedMessage) => { messages.push(message); },
      setSessionId: (id: string) => { nativeIds.push(id); },
    };

    await provider.runtime.run(
      'first\nprompt',
      { sessionId: 'app-1', cwd: root, effort: 'high', permissionMode: 'bypassPermissions' },
      writer,
      context(null),
    );

    const args = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')) as string[];
    assert.deepEqual(args, ['-p', 'first\nprompt', '--output-format', 'stream-json', '--mode', 'yolo', '--cwd', root]);
    assert.ok(nativeIds.includes('sess_native_zcode'));

    // Weekend Build and Start Plan are not honored headless: each is stopped at its first report and recorded,
    // then the Coding Plan runs GLM-5.3-Flash with the requested reasoning level.
    assert.deepEqual(await runs(root), [
      'account:zai-offpeak-idle-plan/GLM-5.3-Flash', 'account:zai-start-plan/GLM-5.3-Flash', 'account:zai-individual-coding-plan/GLM-5.3-Flash',
    ]);
    const configRaw = JSON.parse(await readFile(path.join(root, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.deepEqual(configRaw.config.defaultModelSelection, { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } });
    const state = await planState(root);
    assert.match(state.plans['account:zai-start-plan'].reason, /reported account:zai-individual-coding-plan\/GLM-5\.3, not the requested account:zai-start-plan\/GLM-5\.3-Flash/);
    assert.ok(state.plans['account:zai-offpeak-idle-plan']);
    assert.equal(state.sessions['app-1'], 'account:zai-individual-coding-plan');
    assert.equal(messages.filter((message) => message.kind === 'error').length, 0);

    assert.equal(messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content).join(''), 'Hello from ZCode');
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.exitCode, 0);

    const history = await provider.sessions.fetchHistory('app-1');
    assert.deepEqual(
      history.messages.filter((message) => message.kind === 'text').map((message) => [message.role, message.content]),
      [['user', 'first\nprompt'], ['assistant', 'Hello from ZCode']],
    );
    const tool = history.messages.find((message) => message.kind === 'tool_use');
    assert.equal(tool?.toolName, 'run_command');
    assert.deepEqual(tool?.toolInput, { CommandLine: 'pwd' });
    assert.equal(tool?.toolResult?.content, '/tmp');
    assert.equal(history.messages.filter((message) => message.kind === 'tool_use').length, 1);

    // Resuming a turn passes --resume
    await provider.runtime.run(
      'continue',
      { sessionId: 'app-1', cwd: root, effort: 'low', permissionMode: 'plan' },
      writer,
      context('sess_native_zcode'),
    );
    const resumeArgs = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')) as string[];
    assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], 'sess_native_zcode');
    assert.equal(resumeArgs[resumeArgs.indexOf('--mode') + 1], 'plan');

    const configResume = JSON.parse(await readFile(path.join(root, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(configResume.config.defaultModelSelection.options.reasoningLevel, 'low');
    // The resume asks for the plan its conversation runs on; the skipped plans stay in cooldown.
    assert.equal((await runs(root)).length, 4);

    const page = await provider.sessions.fetchHistory('app-1', { limit: 1 });
    assert.equal(page.total, 6);
    assert.equal(page.messages[0].content, 'Hello from ZCode');
    assert.equal(page.hasMore, true);

    const raw = await readFile(path.join(root, '.cloudcli', 'zcode', 'app-1.jsonl'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 18);
  });
});

test('zcode maps every effort to a supported reasoning level', async () => {
  await withCli(async (root, provider) => {
    for (const [effort, expected] of [[undefined, 'high'], ['low', 'low'], ['medium', 'high'], ['high', 'high'], ['max', 'max'], ['unknown', 'high']] as const) {
      await provider.runtime.run('test', { sessionId: 'effort-test', cwd: root, effort }, { send: () => {} }, context(null));
      const config = JSON.parse(await readFile(path.join(root, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
      assert.equal(config.config.defaultModelSelection.options.reasoningLevel, expected);
    }
  }, { ZCODE_TEST_HONORED: 'account:zai-offpeak-idle-plan,account:zai-start-plan,account:zai-individual-coding-plan' });
});

test('zcode streams native multi-step events before the process exits and restores history', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    let finished = false;
    const running = provider.runtime.run('live', { sessionId: 'app-live', cwd: root }, {
      send: (message) => { messages.push(message as NormalizedMessage); },
    }, context(null)).then(() => { finished = true; });
    try {
      for (let i = 0; i < 100 && !messages.some((message) => message.kind === 'tool_use'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(finished, false);
      assert.equal(messages.find((message) => message.kind === 'stream_delta')?.content, 'Working');
      assert.equal(messages.find((message) => message.kind === 'tool_use')?.toolName, 'bash');
      const before = await readFile(path.join(root, '.cloudcli', 'zcode', 'app-live.jsonl'), 'utf8');
      assert.match(before, /model\.streaming/);
      await running;
      assert.equal(messages.find((message) => message.kind === 'tool_result')?.content, '/tmp');
      assert.equal(messages.at(-1)?.exitCode, 0);
      const history = await provider.sessions.fetchHistory('app-live');
      assert.deepEqual(history.messages.filter((message) => message.kind === 'text').map((message) => message.content), ['live', 'Working', 'Done']);
      assert.equal(history.messages.find((message) => message.kind === 'tool_use')?.toolResult?.content, '/tmp');
      const transcript = await readFile(path.join(root, '.cloudcli', 'zcode', 'app-live.jsonl'), 'utf8');
      assert.match(transcript, /"kind":"progress"/);
      assert.match(transcript, /turn\.completed/);
    } finally { await running; }
  }, { ZCODE_TEST_HONORED: 'account:zai-offpeak-idle-plan,account:zai-start-plan,account:zai-individual-coding-plan' });
});

test('zcode moves past a quota-exhausted plan without surfacing its 1310', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    await provider.runtime.run('hi', { sessionId: 'app-quota', cwd: root }, { send: (message) => { messages.push(message as NormalizedMessage); } }, context(null));
    assert.deepEqual(await runs(root), [
      'account:zai-offpeak-idle-plan/GLM-5.3-Flash', 'account:zai-start-plan/GLM-5.3-Flash', 'account:zai-individual-coding-plan/GLM-5.3-Flash',
    ]);
    const state = await planState(root);
    assert.equal(state.plans['account:zai-start-plan'].until, quotaReset.toISOString());
    assert.match(state.plans['account:zai-start-plan'].reason, /1310/);
    assert.equal(messages.filter((message) => message.kind === 'error').length, 0);
    assert.equal(messages.at(-1)?.exitCode, 0);
    const raw = await readFile(path.join(root, '.cloudcli', 'zcode', 'app-quota.jsonl'), 'utf8');
    assert.equal(raw.split('\n').filter((row) => row.includes('provider_fallback')).length, 2);
  }, { ZCODE_TEST_HONORED: 'account:zai-start-plan,account:zai-individual-coding-plan', ZCODE_TEST_EXHAUSTED: 'account:zai-start-plan' });
});

test('zcode fails loudly instead of running full GLM-5.3 when Flash was requested', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    await provider.runtime.run('hi', { sessionId: 'app-full', cwd: root }, { send: (message) => { messages.push(message as NormalizedMessage); } }, context(null));
    assert.equal(messages.at(-1)?.exitCode, 1);
    assert.equal(messages.filter((message) => message.kind === 'stream_delta').length, 0);
    const error = messages.find((message) => message.kind === 'error');
    assert.match(String(error?.content), /reported account:zai-individual-coding-plan\/GLM-5\.3, not the requested account:zai-individual-coding-plan\/GLM-5\.3-Flash .*stopped/);
  }, { ZCODE_TEST_FORCE: 'account:zai-individual-coding-plan|GLM-5.3' });
});

test('zcode reports a failed result even when the process exits zero', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    await provider.runtime.run(
      'fail',
      { sessionId: 'app-fail', cwd: root },
      { send: (message) => { messages.push(message as NormalizedMessage); } },
      context(null),
    );
    assert.equal(messages.at(-1)?.exitCode, 1);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(messages.some((message) => message.kind === 'error'));
  });
});

test('zcode abort terminates the active process and frees its slot', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    const runPromise = provider.runtime.run(
      'hang',
      { sessionId: 'app-hang', cwd: root },
      { send: (message) => { messages.push(message as NormalizedMessage); } },
      context(null),
    );
    for (let i = 0; i < 50; i += 1) {
      if (await readFile(path.join(root, 'args.json'), 'utf8').then(() => true).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(provider.runtime.abort('app-hang'), true);
    await runPromise;
    assert.notEqual(messages.at(-1)?.exitCode, 0);
    assert.equal(provider.runtime.abort('app-hang'), false);
  });
});

test('zcode auth status reflects installed binary and credentials file existence', async () => {
  await withCli(async (root, provider) => {
    // Before credentials file exists
    const statusBefore = await provider.auth.getStatus();
    assert.equal(statusBefore.installed, true);
    assert.equal(statusBefore.authenticated, false);

    // Create dummy credentials file
    await mkdir(path.join(root, '.zcode', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.zcode', 'v2', 'credentials.json'), '{}');

    const statusAfter = await provider.auth.getStatus();
    assert.equal(statusAfter.installed, true);
    assert.equal(statusAfter.authenticated, true);
  });
});

test('zcode probe returns ok when healthy and caches for 10 minutes', async () => {
  resetZcodeProbeCache();
  await withCli(async (root) => {
    const t0 = new Date('2026-11-07T10:00:00.000Z');
    assert.equal(isZcodeProbeHealthy(t0), false);

    const result = await probeZcodeLogin({ now: t0 });
    assert.equal(result.ok, true);
    assert.equal(isZcodeProbeHealthy(t0), true);

    // 5 minutes later: still healthy via cache
    const t5 = new Date('2026-11-07T10:05:00.000Z');
    assert.equal(isZcodeProbeHealthy(t5), true);
    const cached = await probeZcodeLogin({ now: t5 });
    assert.equal(cached.ok, true);

    // 11 minutes later: cache expired
    const t11 = new Date('2026-11-07T10:11:00.000Z');
    assert.equal(isZcodeProbeHealthy(t11), false);

    // A successful turn refreshes the 10-minute window
    recordZcodeSuccess(t11);
    assert.equal(isZcodeProbeHealthy(t11), true);
    assert.equal(isZcodeProbeHealthy(new Date('2026-11-07T10:20:00.000Z')), true);
    assert.equal(isZcodeProbeHealthy(new Date('2026-11-07T10:22:00.000Z')), false);
  });
  resetZcodeProbeCache();
});

test('zcode probe detects project_token_login_failed and clears cache', async () => {
  resetZcodeProbeCache();
  await withCli(async () => {
    const t0 = new Date('2026-11-07T10:00:00.000Z');
    recordZcodeSuccess(t0);
    assert.equal(isZcodeProbeHealthy(t0), true);

    // When probe encounters project_token_login_failed
    resetZcodeProbeCache();
    const result = await probeZcodeLogin({ now: t0 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'login_failed');
      assert.match(result.message, /project_token_login_failed/);
    }
    assert.equal(isZcodeProbeHealthy(t0), false);
  }, { ZCODE_TEST_LOGIN_FAILED: '1' });
  resetZcodeProbeCache();
});

test('zcode probe handles timeout and reports error without caching', async () => {
  resetZcodeProbeCache();
  await withCli(async () => {
    const t0 = new Date('2026-11-07T10:00:00.000Z');
    const result = await probeZcodeLogin({ timeoutMs: 100, now: t0 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'timeout');
      assert.match(result.message, /timed out after 100ms/);
    }
    assert.equal(isZcodeProbeHealthy(t0), false);
  }, { ZCODE_TEST_PROBE_HANG: '1' });
  resetZcodeProbeCache();
});
