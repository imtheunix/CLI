import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorJobsDb, userDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';

import { cleanupJob } from '../services/cleanup.service.js';
import { createJobsService } from '../services/jobs.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

type Fixture = {
  root: string;
  repo: string;
  origin: string;
  config: OrchestratorConfig;
  jobs: ReturnType<typeof createJobsService>;
  pushLog: string;
  installHook: (fail?: boolean) => void;
  createJob: (id: string, branch: string, state?: 'active' | 'cancelled') => { job: OrchestratorJobRow; worktree: string };
  pushes: () => string;
};

async function withFixture(runTest: (ctx: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = mkdtempSync(path.join(os.tmpdir(), 'cancel-safety-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  userDb.createUser('orchestrator', 'hash');

  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'ws', 'demo');
  mkdirSync(path.dirname(repo), { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  commitFile(repo, 'base.txt', 'base\n', 'start');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');

  const config = loadOrchestratorConfig(path.join(root, 'absent.json'));
  config.workspacesRoot = path.join(root, 'ws');
  config.worktreesRoot = path.join(root, 'jobs');
  config.checks = { demo: 'true' };
  config.forgejo.tokenFile = path.join(root, 'no-token');
  config.review.enabled = false;

  const pushLog = path.join(root, 'pushes.log');
  const installHook = (fail = false) => {
    const hook = path.join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\ncat >> ${pushLog}\n${fail ? 'echo "fixture refuses push" >&2\nexit 1\n' : 'exit 0\n'}`);
    chmodSync(hook, 0o755);
  };

  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    stopBackgroundTask: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
    abort: async () => true,
    run: async () => undefined,
  };
  const jobs = createJobsService({
    runtime: runtime as never,
    config: () => config,
    probeZcode: async () => ({ ok: true }),
  });

  const createJob = (id: string, branch: string, state: 'active' | 'cancelled' = 'active') => {
    const worktree = path.join(config.worktreesRoot, path.basename(repo), id);
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree);
    const job = orchestratorJobsDb.create({
      id,
      title: id,
      prompt: 'p',
      repoPath: repo,
      baseBranch: 'main',
      requestedBackend: 'claude',
      branch,
      worktreePath: worktree,
    });
    orchestratorJobsDb.update(id, { state, merge_step: 'none' });
    return { job: orchestratorJobsDb.get(id) as OrchestratorJobRow, worktree };
  };

  try {
    await runTest({
      root, repo, origin, config, jobs, pushLog, installHook, createJob,
      pushes: () => existsSync(pushLog) ? readFileSync(pushLog, 'utf8') : '',
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    rmSync(root, { recursive: true, force: true });
  }
}

test('cancel leaves an up-to-date branch alone (no push)', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('uptodate', 'feature/uptodate');
    commitFile(worktree, 'work.txt', 'work\n', 'work');
    git(worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/uptodate');
    ctx.installHook();

    const view = await ctx.jobs.cancel('uptodate');
    assert.equal(view.state, 'cancelled');
    assert.equal(ctx.pushes(), '', 'an up-to-date branch is not pushed again');
  });
});

test('cancel pushes a divergent branch before cleanup can remove the worktree', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('divergent', 'feature/divergent');
    const head = commitFile(worktree, 'work.txt', 'work\n', 'work');
    ctx.installHook();

    const view = await ctx.jobs.cancel('divergent');
    assert.equal(view.state, 'cancelled');
    assert.match(ctx.pushes(), /refs\/heads\/feature\/divergent/);
    assert.equal(git(ctx.origin, 'rev-parse', 'refs/heads/feature/divergent'), head);
  });
});

test('a push failure refuses cancellation and keeps the state and worktree', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('pushfail', 'feature/pushfail');
    commitFile(worktree, 'work.txt', 'work\n', 'work');
    ctx.installHook(true);

    await assert.rejects(ctx.jobs.cancel('pushfail'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'JOB_PUSH_FAILED');
      assert.match((error as Error).message, /could not be pushed to origin/);
      return true;
    });
    const row = orchestratorJobsDb.get('pushfail') as OrchestratorJobRow;
    assert.equal(row.state, 'active', 'the refusal cancelled nothing');
    assert.equal(row.merge_step, 'none');
    assert.ok(existsSync(worktree), 'the worktree is kept');
  });
});

test('--no-push skips the push in cancel and in the later automatic cleanup', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('nopush', 'feature/nopush');
    commitFile(worktree, 'work.txt', 'work\n', 'work');
    ctx.installHook();

    const view = await ctx.jobs.cancel('nopush', { noPush: true });
    assert.equal(view.state, 'cancelled');
    assert.equal((orchestratorJobsDb.get('nopush') as OrchestratorJobRow).cancel_no_push, 1);
    assert.equal(ctx.pushes(), '', 'cancel did not push');
    assert.equal(git(ctx.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/feature/nopush'), '', 'origin has no branch');
    assert.ok(!existsSync(worktree), 'the automatic cleanup removed the worktree without pushing');
  });
});

test('a dry-run cleanup never pushes', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('dryrun', 'feature/dryrun', 'cancelled');
    commitFile(worktree, 'work.txt', 'work\n', 'work');
    ctx.installHook();

    const outcome = await cleanupJob(orchestratorJobsDb.get('dryrun') as OrchestratorJobRow, ctx.config, true);
    assert.equal(outcome.status, 'would clean');
    assert.equal(ctx.pushes(), '', 'a dry run does not push');
    assert.ok(existsSync(worktree), 'a dry run removes nothing');
  });
});

test('a failed cleanup push keeps the worktree and a later manual sweep retries after the remote recovers', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('retry', 'feature/retry', 'cancelled');
    const head = commitFile(worktree, 'work.txt', 'work\n', 'work');
    ctx.installHook(true);

    const failed = await ctx.jobs.sweepCleanup();
    assert.match(failed[0]!.status, /cleanup failed: .*branch push failed/);
    assert.ok(existsSync(worktree), 'a failed push keeps the worktree');
    assert.equal(git(ctx.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/feature/retry'), '', 'origin has no branch yet');

    ctx.installHook(false);
    const retried = await ctx.jobs.sweepCleanup();
    assert.equal(retried[0]!.status, 'cleaned');
    assert.equal(git(ctx.origin, 'rev-parse', 'refs/heads/feature/retry'), head);
    assert.ok(!existsSync(worktree));
  });
});

test('cleanup pushes a commit created after cancellation before removing the worktree', async () => {
  await withFixture(async (ctx) => {
    const { worktree } = ctx.createJob('race', 'feature/race', 'cancelled');
    commitFile(worktree, 'first.txt', 'first\n', 'first');
    ctx.installHook();
    const late = commitFile(worktree, 'late.txt', 'late\n', 'late');

    const outcome = await cleanupJob(orchestratorJobsDb.get('race') as OrchestratorJobRow, ctx.config, false);
    assert.equal(outcome.status, 'cleaned');
    assert.match(ctx.pushes(), new RegExp(late), 'the late commit reached origin');
    assert.equal(git(ctx.origin, 'rev-parse', 'refs/heads/feature/race'), late);
    assert.ok(!existsSync(worktree));
  });
});
