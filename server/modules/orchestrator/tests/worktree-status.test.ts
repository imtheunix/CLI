import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { describeWorktree } from '../services/jobs.service.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(root: string): string {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'file'), 'initial');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

test('describeWorktree leaves an existing worktree unchanged', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worktree-status-live-'));
  try {
    const repo = initRepo(root);
    const worktree = path.join(root, 'worktree');
    mkdirSync(worktree);
    const status = await describeWorktree({
      worktree_path: worktree,
      repo_path: repo,
      branch: 'feature/live',
      state: 'active',
      pushed_sha: null,
    });
    assert.deepEqual(status, {
      exists: true,
      pushedSha: null,
      branch: 'feature/live',
      branchLocal: null,
      branchOrigin: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeWorktree reports a removed merged worktree with its pushed sha', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worktree-status-merged-'));
  try {
    const repo = initRepo(root);
    const status = await describeWorktree({
      worktree_path: path.join(root, 'gone'),
      repo_path: repo,
      branch: 'feature/merged',
      state: 'done',
      pushed_sha: 'abc1234',
    });
    assert.deepEqual(status, {
      exists: false,
      pushedSha: 'abc1234',
      branch: 'feature/merged',
      branchLocal: null,
      branchOrigin: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeWorktree reports a cancelled job\'s branch on disk and on origin', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worktree-status-cancelled-'));
  try {
    const repo = initRepo(root);
    const remote = path.join(root, 'origin.git');
    git(root, 'init', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'feature/cancelled');
    git(repo, 'push', '-q', 'origin', 'feature/cancelled');

    const status = await describeWorktree({
      worktree_path: path.join(root, 'gone'),
      repo_path: repo,
      branch: 'feature/cancelled',
      state: 'cancelled',
      pushed_sha: null,
    });
    assert.equal(status.exists, false);
    assert.equal(status.branchLocal, true);
    assert.equal(status.branchOrigin, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeWorktree reports a cancelled job whose branch is gone everywhere', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worktree-status-gone-'));
  try {
    const repo = initRepo(root);
    const status = await describeWorktree({
      worktree_path: path.join(root, 'gone'),
      repo_path: repo,
      branch: 'feature/gone',
      state: 'cancelled',
      pushed_sha: null,
    });
    assert.equal(status.exists, false);
    assert.equal(status.branchLocal, false);
    assert.equal(status.branchOrigin, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
