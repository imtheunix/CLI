import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { OrchestratorJobRow } from '@/modules/database/index.js';

import { cleanupJob } from '../services/cleanup.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';

test('cleanup preserves dirty worktrees and branches, and dry run changes nothing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-cleanup-'));
  try {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'jobs', 'repo', 'abc123');
    const build = path.join(root, 'build', 'abc123');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'file'), 'initial');
    git(repo, 'add', 'file');
    git(repo, 'commit', '-m', 'initial');
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'job-branch', worktree);
    mkdirSync(build, { recursive: true });
    const config = loadOrchestratorConfig(path.join(root, 'absent'));
    config.worktreesRoot = path.join(root, 'jobs');
    config.cleanup.buildDirs.repo = path.join(root, 'build', '{id}');
    const job = { id: 'abc123', repo_path: repo, worktree_path: worktree } as OrchestratorJobRow;
    assert.equal((await cleanupJob(job, config, true)).status, 'would clean');
    assert.ok(existsSync(worktree) && existsSync(build));
    writeFileSync(path.join(worktree, 'untracked'), 'keep');
    assert.match((await cleanupJob(job, config, false)).status, /dirty/);
    assert.ok(existsSync(worktree) && existsSync(build));
    rmSync(path.join(worktree, 'untracked'));
    assert.equal((await cleanupJob(job, config, false)).status, 'cleaned');
    assert.ok(!existsSync(worktree) && !existsSync(build));
    git(repo, 'rev-parse', '--verify', 'job-branch');
    assert.equal((await cleanupJob(job, config, false)).status, 'cleaned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup prunes the job checkpoint refs once the worktree is removed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-cleanup-prune-'));
  try {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'jobs', 'repo', 'prune01');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const refs = (cwd: string) => execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/tribeira/checkpoints/prune01/'], { cwd }).toString().trim().split('\n').filter((line) => line);
    mkdirSync(repo);
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'file'), 'initial');
    git(repo, 'add', 'file');
    git(repo, 'commit', '-m', 'initial');
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'job-branch', worktree);
    const config = loadOrchestratorConfig(path.join(root, 'absent'));
    config.worktreesRoot = path.join(root, 'jobs');
    const job = { id: 'prune01', repo_path: repo, worktree_path: worktree } as OrchestratorJobRow;

    // Two ended turns, two checkpoints; a dirty worktree keeps them.
    writeFileSync(path.join(worktree, 'file'), 'turn 1');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    git(repo, 'update-ref', 'refs/tribeira/checkpoints/prune01/1', head);
    git(repo, 'update-ref', 'refs/tribeira/checkpoints/prune01/2', head);
    writeFileSync(path.join(worktree, 'untracked'), 'keep');
    assert.equal((await cleanupJob(job, config, false)).status, 'dirty or inaccessible worktree; kept');
    assert.equal(refs(repo).length, 2);

    rmSync(path.join(worktree, 'untracked'));
    writeFileSync(path.join(worktree, 'file'), 'initial');
    assert.equal((await cleanupJob(job, config, false)).status, 'cleaned');
    assert.ok(!existsSync(worktree));
    assert.deepEqual(refs(repo), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup parks ignored live-state files in the job state dir before removing the worktree', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-cleanup-live-'));
  try {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'jobs', 'repo', 'live01');
    const stateRoot = path.join(root, 'state');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    mkdirSync(repo);
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.test');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'file'), 'initial');
    git(repo, 'add', 'file');
    git(repo, 'commit', '-m', 'initial');
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'job-branch', worktree);
    // The ledger shape of the 2026-11-07 loss: gitignored data and log files, no tracked change in sight.
    writeFileSync(path.join(worktree, '.gitignore'), 'data/\nlogs/\ndist/\n');
    git(worktree, 'add', '.gitignore');
    git(worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ignore');
    mkdirSync(path.join(worktree, 'data'), { recursive: true });
    writeFileSync(path.join(worktree, 'data', 'arena.sqlite'), 'ledger');
    writeFileSync(path.join(worktree, 'data', 'arena.sqlite-wal'), 'wal');
    mkdirSync(path.join(worktree, 'logs'), { recursive: true });
    writeFileSync(path.join(worktree, 'logs', 'run.jsonl'), '{}');
    // Inside a build dir the same extension is reproducible output: it stays behind.
    mkdirSync(path.join(worktree, 'dist'), { recursive: true });
    writeFileSync(path.join(worktree, 'dist', 'cache.db'), 'junk');
    const config = loadOrchestratorConfig(path.join(root, 'absent'));
    config.worktreesRoot = path.join(root, 'jobs');
    const job = { id: 'live01', repo_path: repo, worktree_path: worktree } as OrchestratorJobRow;

    const preview = await cleanupJob(job, config, true, { stateRoot });
    assert.match(preview.status, /would move 3 live-state file\(s\)/);
    assert.ok(existsSync(worktree), 'dry run removes nothing');

    const outcome = await cleanupJob(job, config, false, { stateRoot });
    assert.match(outcome.status, /^cleaned; moved 3 live-state file\(s\)/);
    assert.ok(!existsSync(worktree));
    const parked = path.join(stateRoot, 'live01');
    assert.equal(readFileSync(path.join(parked, 'data', 'arena.sqlite'), 'utf8'), 'ledger');
    assert.equal(readFileSync(path.join(parked, 'data', 'arena.sqlite-wal'), 'utf8'), 'wal');
    assert.equal(readFileSync(path.join(parked, 'logs', 'run.jsonl'), 'utf8'), '{}');
    assert.ok(!existsSync(path.join(parked, 'dist')), 'build-dir files are not parked');

    // Cleaning again stays "cleaned": the parked folder is not re-reported.
    assert.equal((await cleanupJob(job, config, false, { stateRoot })).status, 'cleaned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
