import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';

test('OpenCode passes supported efforts as --variant on new and resumed runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-effort-'));
  const capturePath = path.join(root, 'args.json');
  const oldPath = process.env.PATH;
  try {
    const executable = path.join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    const scriptPath = path.join(root, 'fake.cjs');
    await writeFile(scriptPath, `
require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'text', sessionID: 'ses_effort', text: 'ok' }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_effort' }));
`);
    await writeFile(executable, process.platform === 'win32'
      ? '@echo off\r\nnode "%~dp0fake.cjs" %*\r\n'
      : '#!/bin/sh\nnode "$(dirname "$0")/fake.cjs" "$@"\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${root}${path.delimiter}${oldPath ?? ''}`;
    const context = {
      resolveProviderSessionId: (id: string) => id || null,
      resolveResumeModel: async (_id: string, model: string) => model,
      getProviderModels: async () => ({
        DEFAULT: 'zai-coding-plan/glm-5.3',
        OPTIONS: ['glm-5.3', 'glm-5.3-flash'].map((model) => ({
          value: `zai-coding-plan/${model}`,
          label: model,
          effort: { default: 'medium', values: ['low', 'medium', 'high', 'max'].map((value) => ({ value })) },
        })),
      }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };
    const writer = { userId: null, sessionId: null, send: () => {}, setSessionId: () => {} };
    for (const model of ['glm-5.3', 'glm-5.3-flash']) {
      for (const effort of ['medium', 'high', 'invalid', 'default']) {
        for (const sessionId of [undefined, 'ses_effort']) {
          await opencodeRuntime.run('hello', { cwd: root, model: `zai-coding-plan/${model}`, effort, sessionId }, writer, context);
          const args: string[] = JSON.parse(await readFile(capturePath, 'utf8'));
          const index = args.indexOf('--variant');
          if (effort === 'medium' || effort === 'high') {
            assert.ok(index >= 0);
            assert.equal(args[index + 1], effort);
          } else {
            assert.equal(index, -1);
          }
          assert.equal(args.includes('--session'), Boolean(sessionId));
        }
      }
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
