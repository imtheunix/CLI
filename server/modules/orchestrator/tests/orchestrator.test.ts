import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorJobsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { createJobsService } from '@/modules/orchestrator/services/jobs.service.js';
import { createMergeQueueService } from '@/modules/orchestrator/services/merge-queue.service.js';
import { loadOrchestratorConfig } from '@/modules/orchestrator/services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '@/modules/orchestrator/services/orchestrator-config.service.js';
import { runCommand } from '@/modules/orchestrator/services/workspace.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

type Turn = { sessionId: string; command: string; options: Record<string, unknown> };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

/** A provider runtime whose turns stay open until the test ends them, like a real agent's. */
function createRuntime() {
  const turns: Turn[] = [];
  const open = new Map<string, () => void>();
  return {
    turns,
    finish(sessionId: string, options: { aborted?: boolean } = {}) {
      chatRunRegistry.completeRun(sessionId, { exitCode: 0, aborted: options.aborted });
      open.get(sessionId)?.();
    },
    gateway: {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
      pushUserMessage: async () => false,
      abort: async () => true,
      run: (_provider: string, command: string, options: Record<string, unknown>) => {
        const sessionId = String(options.sessionId);
        turns.push({ sessionId, command, options });
        return new Promise<void>((resolve) => open.set(sessionId, resolve));
      },
    },
  };
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A workspace with an origin, its main checkout, and an orchestrator wired to both. */
async function withWorkspace(
  runTest: (ctx: {
    root: string;
    repo: string;
    upstream: string;
    config: OrchestratorConfig;
    runtime: ReturnType<typeof createRuntime>;
    jobs: ReturnType<typeof createJobsService>;
    job: (id: string) => OrchestratorJobRow;
  }) => Promise<void>,
  tune: (config: OrchestratorConfig) => void = () => undefined,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'orchestrator-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  userDb.createUser('orchestrator', 'hash');

  const origin = path.join(root, 'origin.git');
  const workspaces = path.join(root, 'ws');
  const repo = path.join(workspaces, 'demo');
  const upstream = path.join(root, 'upstream');
  await mkdir(workspaces, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  commitFile(repo, 'app.txt', 'one\ntwo\nthree\n', 'start');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // Someone else pushing to main meanwhile.
  git(root, 'clone', '-q', origin, upstream);

  const config = loadOrchestratorConfig(path.join(root, 'none.json'));
  config.workspacesRoot = workspaces;
  config.worktreesRoot = path.join(workspaces, '.jobs');
  config.checks = { demo: 'true' };
  config.forgejo.tokenFile = path.join(root, 'no-token');
  tune(config);

  const runtime = createRuntime();
  const jobs = createJobsService({ runtime: runtime.gateway, config: () => config });
  const unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
  try {
    await runTest({ root, repo, upstream, config, runtime, jobs, job: (id) => orchestratorJobsDb.get(id) as OrchestratorJobRow });
  } finally {
    unsubscribe();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('jobs go to the least busy backend, each a named session in its own worktree', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const created: Array<{ id: string }> = [];
    for (const title of ['one', 'two', 'three', 'four']) {
      created.push(await jobs.create({ title, prompt: `do ${title}`, repoPath: repo, backend: null, baseBranch: null }));
      await eventually(() => job(created.at(-1)!.id).state === 'active', `${title} to start`);
    }
    assert.deepEqual(created.map((c) => job(c.id).backend), ['glm', 'codex', 'claude', 'glm']);

    const first = job(created[0].id);
    assert.equal(first.base_branch, 'main');
    assert.ok(existsSync(path.join(first.worktree_path, 'app.txt')));
    assert.equal(git(first.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD'), first.branch);
    const session = sessionsDb.getSessionById(first.session_id!) as { custom_name: string; provider: string; model: string; project_path: string };
    assert.equal(session.custom_name, 'GLM · one');
    assert.equal(session.provider, 'opencode');
    assert.equal(session.model, 'zai-coding-plan/glm-5.3');

    const turn = runtime.turns.find((t) => t.sessionId === first.session_id)!;
    assert.match(turn.command, /do one/);
    assert.match(turn.command, new RegExp(`tjob done ${first.id}`));
    assert.equal(turn.options.permissionMode, 'bypassPermissions');
    assert.equal(turn.options.cwd, first.worktree_path);
  });
});

test('a requested backend at its cap sends the job to GLM; with GLM full too, it waits for a slot', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const a = await jobs.create({ title: 'a', prompt: 'a', repoPath: repo, backend: 'claude', baseBranch: null });
    await eventually(() => job(a.id).state === 'active', 'a');
    const b = await jobs.create({ title: 'b', prompt: 'b', repoPath: repo, backend: 'claude', baseBranch: null });
    await eventually(() => job(b.id).state === 'active', 'b');
    const c = await jobs.create({ title: 'c', prompt: 'c', repoPath: repo, backend: 'claude', baseBranch: null });
    await eventually(() => job(c.id).state === 'active', 'c');
    assert.deepEqual([a, b, c].map((j) => job(j.id).backend), ['claude', 'claude', 'glm']);

    const waiting = await jobs.create({ title: 'd', prompt: 'd', repoPath: repo, backend: 'claude', baseBranch: null });
    assert.equal(job(waiting.id).state, 'queued');

    // Stopping a job is "finished": its slot frees, and the waiting job takes it.
    runtime.finish(job(a.id).session_id!, { aborted: true });
    assert.equal(job(a.id).state, 'interrupted');
    await jobs.tick();
    await eventually(() => job(waiting.id).state === 'active', 'd to start');
    assert.equal(job(waiting.id).backend, 'claude');
  }, (config) => { config.backends.glm.cap = 1; });
});

test('a session waiting for an answer keeps its slot; only `done` with committed work frees it', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const created = await jobs.create({ title: 'feature', prompt: 'p', repoPath: repo, backend: 'codex', baseBranch: null });
    await eventually(() => job(created.id).state === 'active', 'start');
    const { session_id: sessionId, worktree_path: worktree } = job(created.id);

    runtime.finish(sessionId!); // the agent asked a question and ended its turn
    assert.equal(job(created.id).state, 'active');
    assert.equal(jobs.get(created.id)!.activity, 'waiting');
    assert.equal(jobs.loads().codex, 1);

    await assert.rejects(jobs.markDone(created.id), /no commits ahead/);
    writeFileSync(path.join(worktree, 'new.txt'), 'x');
    await assert.rejects(jobs.markDone(created.id), /uncommitted/);
    git(worktree, 'add', 'new.txt');
    git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feature');

    const done = await jobs.markDone(created.id);
    assert.equal(done.state, 'done');
    assert.equal(done.merge_step, 'queued');
    assert.equal(jobs.loads().codex, 0);
  });
});

test('after a restart, a job that was mid-turn is told to continue', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const created = await jobs.create({ title: 'long', prompt: 'p', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => job(created.id).state === 'active', 'start');
    assert.equal(job(created.id).in_turn, 1);

    chatRunRegistry.clearAll(); // the server went away mid-turn: no run, no completion
    await jobs.recover();
    const last = runtime.turns.at(-1)!;
    assert.equal(last.sessionId, job(created.id).session_id);
    assert.match(last.command, /restarted/);
  });
});

async function finishedJob(ctx: Parameters<Parameters<typeof withWorkspace>[0]>[0], change: (worktree: string) => void) {
  const created = await ctx.jobs.create({ title: 'change', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
  await eventually(() => ctx.job(created.id).state === 'active', 'start');
  const worktree = ctx.job(created.id).worktree_path;
  change(worktree);
  ctx.runtime.finish(ctx.job(created.id).session_id!);
  await ctx.jobs.markDone(created.id);
  return created.id;
}

async function drain(queue: ReturnType<typeof createMergeQueueService>, job: () => OrchestratorJobRow, until: string[]): Promise<void> {
  for (let i = 0; i < 20 && !until.includes(job().merge_step); i += 1) await queue.tick();
}

test('a finished branch is rebased, checked, pushed, and merged when no CI picks it up', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    commitFile(ctx.upstream, 'other.txt', 'o\n', 'someone else');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');

    let clock = Date.now();
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config, now: () => clock });
    await drain(queue, () => ctx.job(id), ['deploy']);
    assert.equal(ctx.job(id).merge_step, 'deploy');
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.ok(existsSync(path.join(ctx.upstream, 'feature.txt')));
    assert.ok(existsSync(path.join(ctx.upstream, 'other.txt')));
    assert.equal(ctx.job(id).pushed_sha, git(ctx.upstream, 'rev-parse', 'HEAD'));

    clock += 10 * 60_000;
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');
  });
});

test('conflicts are handed to the resolver model, then the merge goes on', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'app.txt', 'one\nTWO\nthree\n', 'shout two'));
    commitFile(ctx.upstream, 'app.txt', 'one\n2\nthree\n', 'number two');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');

    const resolverCalls: string[] = [];
    const run: typeof runCommand = async (command, args, options) => {
      if (command !== ctx.config.conflictResolver.command) return runCommand(command, args, options);
      resolverCalls.push(args[args.indexOf('--model') + 1]);
      const cwd = options!.cwd;
      writeFileSync(path.join(cwd, 'app.txt'), 'one\nTWO (2)\nthree\n');
      await runCommand('git', ['add', 'app.txt'], { cwd });
      return runCommand('git', ['-c', 'core.editor=true', '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '--continue'], { cwd });
    };
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config, run });
    await drain(queue, () => ctx.job(id), ['deploy', 'blocked', 'none']);

    assert.deepEqual(resolverCalls, ['gemini-3.8-flash-medium']);
    assert.equal(ctx.job(id).merge_step, 'deploy');
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.equal(readFileSync(path.join(ctx.upstream, 'app.txt'), 'utf8'), 'one\nTWO (2)\nthree\n');
  });
});

test('failing checks go back to the agent, whose job takes its slot again', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await drain(queue, () => ctx.job(id), ['none']);

    assert.equal(ctx.job(id).state, 'active');
    assert.equal(ctx.job(id).merge_step, 'none');
    assert.match(ctx.runtime.turns.at(-1)!.command, /`echo broken; false` failed:[\s\S]*broken/);
    assert.equal(git(ctx.upstream, 'ls-remote', 'origin', 'main').split('\t')[0], git(ctx.repo, 'rev-parse', 'origin/main'));
  }, (config) => { config.checks = { demo: 'echo broken; false' }; });
});

test('main moving during the queue sends the job back to rebase, not to a failed push', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await drain(queue, () => ctx.job(id), ['push']);

    // Another job's push lands between the checks and this push.
    commitFile(ctx.upstream, 'race.txt', 'r\n', 'race');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'rebase');
    assert.equal(ctx.job(id).merge_attempts, 1);

    await drain(queue, () => ctx.job(id), ['deploy']);
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.ok(existsSync(path.join(ctx.upstream, 'feature.txt')));
  });
});

test('a restart between the push and recording it resumes at the deploy, without pushing twice', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    const worktree = ctx.job(id).worktree_path;
    git(worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    orchestratorJobsDb.update(id, { merge_step: 'push' });

    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'deploy');
    assert.equal(ctx.job(id).pushed_sha, git(worktree, 'rev-parse', 'HEAD'));
  });
});

test('the deploy is watched on Forgejo: running waits, a failure blocks and tells the agent, retry watches again', async () => {
  await withWorkspace(async (ctx) => {
    writeFileSync(ctx.config.forgejo.tokenFile, 'secret\n');
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    let status = 'running';
    const requests: string[] = [];
    const fetchJson = async (url: string, token: string) => {
      requests.push(url);
      assert.equal(token, 'secret');
      return { workflow_runs: [{ id: 9, workflow_id: 'ci.yml', commit_sha: ctx.job(id).pushed_sha, status }] };
    };
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config, fetchJson });
    await drain(queue, () => ctx.job(id), ['deploy']);
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'deploy');
    assert.match(requests[0], /\/repos\/[^/]+\/origin\/actions\/runs/);

    status = 'failure';
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'blocked');
    assert.match(ctx.job(id).last_error!, /ci\.yml#9: failure/);
    assert.match(ctx.runtime.turns.at(-1)!.command, /blocked/);
    assert.equal(ctx.job(id).state, 'done');

    queue.retry(ctx.job(id));
    status = 'success';
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');
  });
});

test('one job at a time per repository goes from rebase to push', async () => {
  await withWorkspace(async (ctx) => {
    const first = await finishedJob(ctx, (worktree) => commitFile(worktree, 'a.txt', 'a\n', 'a'));
    const second = await finishedJob(ctx, (worktree) => commitFile(worktree, 'b.txt', 'b\n', 'b'));
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await queue.tick();
    const steps = [ctx.job(first).merge_step, ctx.job(second).merge_step].sort();
    assert.deepEqual(steps, ['queued', 'rebase']);

    await drain(queue, () => ctx.job(second), ['deploy']);
    await drain(queue, () => ctx.job(first), ['deploy']);
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.ok(existsSync(path.join(ctx.upstream, 'a.txt')));
    assert.ok(existsSync(path.join(ctx.upstream, 'b.txt')));
  });
});
