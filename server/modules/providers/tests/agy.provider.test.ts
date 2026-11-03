import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgyProvider } from '../list/agy/agy.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

async function withCli(run: (root: string, provider: AgyProvider) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-provider-'));
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const argsFile = process.env.AGY_TEST_ARGS;
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'bin', 'agy'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.AGY_TEST_ARGS, JSON.stringify(args));
if (args[1] === 'hang') { setInterval(() => {}, 1000); }
else {
const events = [
 {event:'init',conversation_id:'native-agy',init:{model:'gemini-3.8-flash-medium'}},
 {event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'Hello'}},
 {event:'step_update',step_update:{step_index:1,step_type:'agent_response',state:'DONE',text_delta:' world'}},
 {event:'result',result:{conversation_id:'native-agy',status:args[1] === 'fail' ? 'ERROR' : 'SUCCESS',response:'Hello world'}}
];
const text = events.map(e => JSON.stringify(e)).join('\\n');
process.stdout.write(text.slice(0, 23));
setTimeout(() => process.stdout.write(text.slice(23)), 10);
}
`, { mode: 0o700 });
  process.env.HOME = root;
  process.env.PATH = path.join(root, 'bin') + path.delimiter + previousPath;
  process.env.AGY_TEST_ARGS = path.join(root, 'args.json');
  try { await run(root, new AgyProvider()); }
  finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (argsFile === undefined) delete process.env.AGY_TEST_ARGS; else process.env.AGY_TEST_ARGS = argsFile;
    await rm(root, { recursive: true, force: true });
  }
}

function context(nativeId: string | null): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (_id, model) => model ?? undefined,
    getProviderModels: async () => new AgyProvider().models.getSupportedModels(),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

test('agy launches, streams split NDJSON, persists history and resumes by conversation with mapped effort', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    const nativeIds: string[] = [];
    const writer = { send: (message: NormalizedMessage) => { messages.push(message); }, setSessionId: (id: string) => { nativeIds.push(id); } };
    await provider.runtime.run('first\nprompt', { sessionId: 'app-1', cwd: root, model: 'gemini-3.8-flash-medium', effort: 'high', permissionMode: 'bypassPermissions' }, writer, context(null));
    const args = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')) as string[];
    assert.deepEqual(args, ['-p', 'first\nprompt', '--model', 'gemini-3.8-flash-medium', '--output-format', 'stream-json', '--effort', 'high', '--dangerously-skip-permissions']);
    assert.ok(nativeIds.includes('native-agy'));
    assert.equal(messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content).join(''), 'Hello world');
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.exitCode, 0);
    const history = await provider.sessions.fetchHistory('app-1');
    assert.deepEqual(history.messages.filter((message) => message.kind === 'text').map((message) => [message.role, message.content]), [['user', 'first\nprompt'], ['assistant', 'Hello world']]);
    await provider.runtime.run('continue', { sessionId: 'app-1', cwd: root, effort: 'low', permissionMode: 'bypassPermissions' }, writer, context('native-agy'));
    const resumeArgs = JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')) as string[];
    assert.equal(resumeArgs[resumeArgs.indexOf('--conversation') + 1], 'native-agy');
    assert.equal(resumeArgs[resumeArgs.indexOf('--effort') + 1], 'low');
    const page = await provider.sessions.fetchHistory('app-1', { limit: 1 });
    assert.equal(page.total, 4);
    assert.equal(page.messages[0].content, 'Hello world');
    assert.equal(page.hasMore, true);
    const raw = await readFile(path.join(root, '.cloudcli', 'agy', 'app-1.jsonl'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 10);
  });
});

test('agy reports a failed result even when the process exits zero', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    await provider.runtime.run('fail', { sessionId: 'app-fail', cwd: root }, { send: (message) => { messages.push(message); } }, context(null));
    assert.equal(messages.at(-1)?.exitCode, 1);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(messages.some((message) => message.kind === 'error'));
  });
});

test('agy abort terminates the active process and frees its slot', async () => {
  await withCli(async (root, provider) => {
    const messages: NormalizedMessage[] = [];
    const turn = provider.runtime.run('hang', { sessionId: 'app-hang', cwd: root }, { send: (message) => { messages.push(message); } }, context(null));
    for (let i = 0; i < 100; i++) {
      try { await readFile(path.join(root, 'args.json')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.equal(await provider.runtime.abort('app-hang'), true);
    await turn;
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(await provider.runtime.abort('app-hang'), false);
  });
});

test('agy spawn failures emit one error completion and unsupported effort is rejected', async () => {
  await withCli(async (root, provider) => {
    process.env.PATH = root;
    const messages: NormalizedMessage[] = [];
    await provider.runtime.run('missing', { sessionId: 'app-missing', cwd: root }, { send: (message) => { messages.push(message); } }, context(null));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.exitCode, 1);
    await assert.rejects(provider.runtime.run('bad', { sessionId: 'bad', effort: 'ultra' }, { send() {} }, context(null)), /Unsupported agy effort/);
  });
});
