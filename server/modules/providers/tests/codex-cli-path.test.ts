import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCodexCliPath } from '@/modules/providers/list/codex/codex-cli-path.js';

const executables = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

test('resolveCodexCliPath prefers CODEX_PATH over PATH', () => {
  const resolved = resolveCodexCliPath({
    env: { CODEX_PATH: ' /opt/codex/bin/codex ', PATH: '/home/u/.local/bin' },
    platform: 'linux',
    isExecutable: executables('/home/u/.local/bin/codex'),
  });

  assert.deepEqual(resolved, { path: '/opt/codex/bin/codex', source: 'env' });
});

test('resolveCodexCliPath takes the first codex on PATH, skipping node_modules shims', () => {
  const resolved = resolveCodexCliPath({
    env: { PATH: '/app/node_modules/.bin:/usr/bin:/home/u/.local/bin:/usr/local/bin' },
    platform: 'linux',
    isExecutable: executables('/app/node_modules/.bin/codex', '/home/u/.local/bin/codex', '/usr/local/bin/codex'),
  });

  assert.deepEqual(resolved, { path: '/home/u/.local/bin/codex', source: 'path' });
});

test('resolveCodexCliPath keeps a global npm install found through its prefix bin', () => {
  const resolved = resolveCodexCliPath({
    env: { PATH: '/home/u/.local/share/node/lib/node_modules/@openai/codex/node_modules/.bin:/home/u/.local/bin' },
    platform: 'linux',
    isExecutable: executables(
      '/home/u/.local/share/node/lib/node_modules/@openai/codex/node_modules/.bin/codex',
      '/home/u/.local/bin/codex',
    ),
  });

  assert.deepEqual(resolved, { path: '/home/u/.local/bin/codex', source: 'path' });
});

test('resolveCodexCliPath falls back to the SDK bundled binary when nothing is found', () => {
  const resolved = resolveCodexCliPath({
    env: { PATH: '/usr/bin:/bin', CODEX_PATH: '  ' },
    platform: 'linux',
    isExecutable: () => false,
  });

  assert.deepEqual(resolved, { path: undefined, source: 'bundled' });
});
