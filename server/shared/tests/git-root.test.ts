import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findTopmostGitRoot } from '@/shared/utils.js';

test('skill discovery finds nested repository roots without crossing the home boundary', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-git-root-'));
  const home = path.join(root, 'home');
  const repo = path.join(home, 'repo');
  const workspace = path.join(repo, 'packages/app');
  context.mock.method(os, 'homedir', () => home);
  try {
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    assert.equal(await findTopmostGitRoot(workspace), repo);
    assert.equal(await findTopmostGitRoot(home), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
