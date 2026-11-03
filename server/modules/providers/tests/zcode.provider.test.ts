import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

import { ZcodeProvider } from '../list/zcode/zcode.provider.js';

async function withCli(run: (root: string, provider: ZcodeProvider) => Promise<void>) {
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
else {
const events = [
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
`, { mode: 0o700 });
  process.env.HOME = root;
  process.env.PATH = path.join(root, 'bin') + path.delimiter + previousPath;
  process.env.ZCODE_TEST_ARGS = path.join(root, 'args.json');
  try { await run(root, new ZcodeProvider()); }
  finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (argsFile === undefined) delete process.env.ZCODE_TEST_ARGS; else process.env.ZCODE_TEST_ARGS = argsFile;
    await rm(root, { recursive: true, force: true });
  }
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

    // Verify ~/.zcode/v2/provider_config.json was configured with GLM-5.3-Flash and reasoningLevel: high
    const configRaw = JSON.parse(await readFile(path.join(root, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    assert.equal(configRaw.config.defaultModelSelection.modelId, 'GLM-5.3-Flash');
    assert.equal(configRaw.config.defaultModelSelection.options.reasoningLevel, 'high');

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

    const page = await provider.sessions.fetchHistory('app-1', { limit: 1 });
    assert.equal(page.total, 6);
    assert.equal(page.messages[0].content, 'Hello from ZCode');
    assert.equal(page.hasMore, true);

    const raw = await readFile(path.join(root, '.cloudcli', 'zcode', 'app-1.jsonl'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 14);
  });
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
