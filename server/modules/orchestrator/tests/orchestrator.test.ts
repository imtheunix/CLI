import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorJobsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { createJobsService } from '../services/jobs.service.js';
import { createMergeQueueService } from '../services/merge-queue.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import { checkEnvironment, runCommand } from '../services/workspace.service.js';
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
  // The balancing tests must not depend on the hour they run at.
  config.glmPeakHours.avoid = false;
  config.review = false;   // the queue's own tests; the review gate has its own
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
    assert.equal(session.custom_name, 'GLM Flash · one');
    assert.equal(session.provider, 'opencode');
    assert.equal(session.model, 'zai-coding-plan/glm-5.3-flash');
    assert.equal(first.model, 'zai-coding-plan/glm-5.3-flash');

    const turn = runtime.turns.find((t) => t.sessionId === first.session_id)!;
    assert.match(turn.command, /do one/);
    assert.match(turn.command, new RegExp(`tjob done ${first.id}`));
    assert.equal(turn.options.permissionMode, 'bypassPermissions');
    assert.equal(turn.options.cwd, first.worktree_path);
  });
});

test('GLM runs Flash by default and the full model on request, kept on every later turn', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const full = await jobs.create({ title: 'hard', prompt: 'p', repoPath: repo, backend: null, model: 'glm-5.3', baseBranch: null });
    await eventually(() => job(full.id).state === 'active', 'hard to start');
    assert.equal(job(full.id).backend, 'glm');
    assert.equal(job(full.id).model, 'zai-coding-plan/glm-5.3');
    const session = sessionsDb.getSessionById(job(full.id).session_id!) as { custom_name: string; model: string; effort: string };
    assert.equal(session.custom_name, 'GLM · hard');
    assert.equal(session.model, 'zai-coding-plan/glm-5.3');
    assert.equal(session.effort, 'medium');

    // A message from the CI/CD queue (or a restart's "continue") runs on the job's model.
    runtime.finish(job(full.id).session_id!);
    await jobs.notify(job(full.id), 'checks failed');
    const turns = runtime.turns.filter((t) => t.sessionId === job(full.id).session_id);
    assert.equal(turns.length, 2);
    assert.ok(turns.every((t) => t.options.model === 'zai-coding-plan/glm-5.3'));
    assert.ok(turns.every((t) => t.options.effort === 'medium'));

    const flash = await jobs.create({ title: 'easy', prompt: 'p', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => job(flash.id).state === 'active', 'easy to start');
    assert.equal(job(flash.id).model, 'zai-coding-plan/glm-5.3-flash');
    assert.equal(jobs.get(flash.id)!.model, 'zai-coding-plan/glm-5.3-flash');
  });
});

test('a model the backend does not offer is refused, naming the ones it does', async () => {
  await withWorkspace(async ({ repo, jobs, job }) => {
    await assert.rejects(
      jobs.create({ title: 'x', prompt: 'p', repoPath: repo, backend: 'claude', model: 'glm-5.3', baseBranch: null }),
      /model glm-5.3 is not offered \(claude: claude-opus-5-5\)/,
    );
    await assert.rejects(
      jobs.create({ title: 'x', prompt: 'p', repoPath: repo, backend: null, model: 'gpt-4', baseBranch: null }),
      /not offered.*glm: zai-coding-plan\/glm-5.3-flash, zai-coding-plan\/glm-5.3/,
    );
    const codex = await jobs.create({ title: 'y', prompt: 'p', repoPath: repo, backend: null, model: 'gpt-6.1-sol', baseBranch: null });
    assert.equal(codex.requested_backend, 'codex');
    await eventually(() => job(codex.id).state === 'active', 'y to start');
  });
});

test('the default model per backend and the peak-hours rule come from orchestrator.json, with no rebuild', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestrator-config-'));
  try {
    const file = path.join(dir, 'orchestrator.json');
    assert.equal(loadOrchestratorConfig(file).backends.glm.model, 'zai-coding-plan/glm-5.3-flash');
    writeFileSync(file, JSON.stringify({ backends: { glm: { model: 'zai-coding-plan/glm-5.3' } }, glmPeakHours: { avoid: false } }));
    const config = loadOrchestratorConfig(file);
    assert.equal(config.backends.glm.model, 'zai-coding-plan/glm-5.3');
    assert.equal(config.backends.glm.models['zai-coding-plan/glm-5.3-flash'], 'GLM Flash');
    assert.equal(config.backends.glm.cap, 3);
    assert.deepEqual(config.glmPeakHours, { avoid: false, utcOffsetHours: 8, fromHour: 14, toHour: 18 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

    // Stop is a change of direction, not the end: the job keeps its slot.
    runtime.finish(job(a.id).session_id!, { aborted: true });
    await jobs.tick();
    assert.equal(job(a.id).state, 'active');
    assert.equal(job(waiting.id).state, 'queued');

    // The person said they do not want it anymore: its slot frees, and the waiting job takes it.
    await jobs.cancel(a.id);
    assert.equal(job(a.id).state, 'cancelled');
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

test("a JavaScript job's linked node_modules does not leave its worktree dirty", async () => {
  await withWorkspace(async ({ repo, jobs, job }) => {
    commitFile(repo, 'package.json', '{}', 'package');
    commitFile(repo, 'package-lock.json', '{}', 'lockfile');
    commitFile(repo, '.gitignore', 'node_modules/\n', 'ignore');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    await mkdir(path.join(repo, 'node_modules'));

    const created = await jobs.create({ title: 'js', prompt: 'p', repoPath: repo, backend: null, baseBranch: null });
    await eventually(() => job(created.id).state === 'active', 'start');
    const worktree = job(created.id).worktree_path;
    assert.ok(existsSync(path.join(worktree, 'node_modules')));
    assert.equal(git(worktree, 'status', '--porcelain'), '');
  });
});

test("checks run without the server's own settings or secrets, as in a plain shell", async () => {
  const env = checkEnvironment({ DATABASE_PATH: '/live/auth.db', NODE_ENV: 'production', CLAUDE_CLI_PATH: '/bin/claude', PLANS_CLIENT_SECRET: 's', HOME: '/home/x' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CLI_PATH', 'DATABASE_PATH', 'NODE_ENV', 'PLANS_CLIENT_SECRET']);
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = '/live/auth.db';
  try {
    const result = await runCommand('echo "${DATABASE_PATH-unset}"', [], { cwd: tmpdir(), shell: true, env: checkEnvironment() });
    assert.equal(result.stdout.trim(), 'unset');
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  }
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
    const message = ctx.runtime.turns.at(-1)!.command;
    assert.match(message, /failed:\s+Failing:\s+```\nnot ok 2 - broken\n```[\s\S]*# fail 1/);
    assert.equal(git(ctx.upstream, 'ls-remote', 'origin', 'main').split('\t')[0], git(ctx.repo, 'rev-parse', 'origin/main'));
  }, (config) => { config.checks = { demo: 'printf "ok 1 - fine\\nnot ok 2 - broken\\n# fail 1\\n"; false' }; });
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

for (const ownStatus of ['cancelled', 'failure', 'missing']) {
  test(`a ${ownStatus} deploy is merged when a successful base-branch descendant deployed it`, async () => {
    await withWorkspace(async (ctx) => {
      writeFileSync(ctx.config.forgejo.tokenFile, 'test-token\n');
      const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
      let descendant = '';
      const queue = createMergeQueueService({
        jobs: ctx.jobs, config: () => ctx.config,
        fetchJson: async () => ({ workflow_runs: [
          { id: 11, workflow_id: 'ci.yml', commit_sha: descendant, status: 'success' },
          ...(ownStatus === 'missing' ? [] : [{ id: 10, workflow_id: 'ci.yml', commit_sha: ctx.job(id).pushed_sha, status: ownStatus }]),
        ] }),
      });
      await drain(queue, () => ctx.job(id), ['deploy']);
      const pushed = ctx.job(id).pushed_sha;
      git(ctx.upstream, 'pull', '-q', 'origin', 'main');
      commitFile(ctx.upstream, 'newer.txt', 'new\n', 'supersede');
      descendant = git(ctx.upstream, 'rev-parse', 'HEAD');
      git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');
      // The deployed descendant need not be the current tip.
      commitFile(ctx.upstream, 'latest.txt', 'latest\n', 'newest push');
      git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');

      await queue.tick();
      assert.equal(ctx.job(id).merge_step, 'merged');
      assert.equal(ctx.job(id).pushed_sha, pushed);
      assert.ok(ctx.job(id).last_error?.includes(descendant));
      assert.match(ctx.job(id).last_error!, /ci\.yml#11: success/);
    });
  });
}

for (const scenario of ['failing descendant', 'unrelated success', 'success off base', 'partly green descendant']) {
  test(`a cancelled deploy still blocks with a ${scenario}`, async () => {
    await withWorkspace(async (ctx) => {
      writeFileSync(ctx.config.forgejo.tokenFile, 'test-token\n');
      const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
      let candidate = '';
      const queue = createMergeQueueService({
        jobs: ctx.jobs, config: () => ctx.config,
        fetchJson: async () => ({ workflow_runs: [
          { id: 11, workflow_id: 'ci.yml', commit_sha: candidate, status: scenario === 'failing descendant' ? 'failure' : 'success' },
          ...(scenario === 'partly green descendant' ? [{ id: 12, workflow_id: 'deploy.yml', commit_sha: candidate, status: 'failure' }] : []),
          { id: 10, workflow_id: 'ci.yml', commit_sha: ctx.job(id).pushed_sha, status: 'cancelled' },
        ] }),
      });
      await drain(queue, () => ctx.job(id), ['deploy']);
      if (scenario === 'unrelated success') {
        candidate = git(ctx.upstream, 'rev-parse', 'HEAD');
      } else {
        git(ctx.upstream, 'pull', '-q', 'origin', 'main');
        commitFile(ctx.upstream, 'newer.txt', 'new\n', 'supersede');
        candidate = git(ctx.upstream, 'rev-parse', 'HEAD');
        git(ctx.upstream, 'push', '-q', 'origin', scenario === 'success off base' ? 'HEAD:other' : 'HEAD:main');
      }
      await queue.tick();
      assert.equal(ctx.job(id).merge_step, 'blocked');
      assert.match(ctx.job(id).last_error!, /ci\.yml#10: cancelled/);
    });
  });
}

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

test('a message from a session goes to the load balancer as a job in that session\'s repository', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    // The sending session may itself be a job, working in a worktree.
    const parent = await jobs.create({ title: 'parent', prompt: 'p', repoPath: repo, backend: 'claude', baseBranch: null });
    await eventually(() => job(parent.id).state === 'active', 'parent');

    const sent = await jobs.createFromSession({
      sessionId: job(parent.id).session_id!,
      content: '\nAdd a dark mode toggle to the settings page\nKeep the current theme as default.',
      backend: null,
    });
    await eventually(() => job(sent.id).state === 'active', 'sent job');
    assert.equal(job(sent.id).repo_path, repo);
    assert.equal(job(sent.id).title, 'Add a dark mode toggle to the settings page');
    assert.equal(job(sent.id).backend, 'glm');
    assert.match(runtime.turns.at(-1)!.command, /Keep the current theme as default\.[\s\S]*Sent to the load balancer from the session "Claude · parent"/);

    await assert.rejects(jobs.createFromSession({ sessionId: 'missing', content: 'x', backend: null }), /not found/);
  });
});

test('a session in no repository is offered the workspace\'s repositories, recently used first', async () => {
  await withWorkspace(async ({ root, repo, jobs }) => {
    const workspaces = path.join(root, 'ws');
    const spare = path.join(workspaces, 'spare');
    git(root, 'clone', '-q', path.join(root, 'origin.git'), spare);
    await mkdir(path.join(workspaces, 'notes'), { recursive: true }); // not a repository
    await mkdir(path.join(workspaces, '.secrets'), { recursive: true }); // hidden

    const loose = path.join(workspaces, 'loose');
    await mkdir(loose, { recursive: true });
    sessionsDb.createAppSession('loose-session', 'claude', loose, 'Loose');
    sessionsDb.createAppSession('repo-session', 'claude', repo, 'In a repo');

    // The workspace's only recent job was for `spare`, so the picker lists it first.
    orchestratorJobsDb.create({
      id: 'oldjob', title: 'old', prompt: 'p', repoPath: spare, baseBranch: 'main',
      requestedBackend: 'glm', branch: 'job/old-oldjob', worktreePath: path.join(root, 'wt-old'),
    });

    const inRepo = await jobs.fromSessionContext({ sessionId: 'repo-session' });
    assert.equal(inRepo.sessionRepoPath, repo);
    assert.deepEqual(inRepo.repos, [
      { name: 'demo', path: repo },
      { name: 'spare', path: spare },
    ]);

    const context = await jobs.fromSessionContext({ sessionId: 'loose-session' });
    assert.equal(context.sessionRepoPath, null);
    assert.equal(context.workspaceRoot, workspaces);
    assert.deepEqual(context.repos.map((entry) => entry.name), ['spare', 'demo']);

    // A newer job for `demo` moves it to the front.
    orchestratorJobsDb.create({
      id: 'newjob', title: 'new', prompt: 'p', repoPath: repo, baseBranch: 'main',
      requestedBackend: 'glm', branch: 'job/new-newjob', worktreePath: path.join(root, 'wt-new'),
    });
    assert.deepEqual((await jobs.fromSessionContext({ sessionId: 'loose-session' })).repos.map((entry) => entry.name), ['demo', 'spare']);
  });
});

test('from a session in no repository, the picked repository takes the job and an unusable one is refused clearly', async () => {
  await withWorkspace(async ({ root, repo, jobs, job }) => {
    const workspaces = path.join(root, 'ws');
    const notes = path.join(workspaces, 'notes');
    const loose = path.join(workspaces, 'loose');
    await mkdir(loose, { recursive: true });
    await mkdir(notes, { recursive: true });
    sessionsDb.createAppSession('loose-session', 'claude', loose, 'Loose');

    const sent = await jobs.createFromSession({ sessionId: 'loose-session', content: 'Tidy the imports', backend: 'glm', repo });
    await eventually(() => job(sent.id).state === 'active', 'sent job');
    assert.equal(job(sent.id).repo_path, repo);
    assert.match(job(sent.id).prompt, /Sent to the load balancer from the session "Loose"/);

    await assert.rejects(
      jobs.createFromSession({ sessionId: 'loose-session', content: 'x', backend: null }),
      (error: Error) => error.message.includes('pick the repository this job is for'),
    );
    await assert.rejects(
      jobs.createFromSession({ sessionId: 'loose-session', content: 'x', backend: null, repo: notes }),
      /notes is not a git repository/,
    );
    await assert.rejects(
      jobs.createFromSession({ sessionId: 'loose-session', content: 'x', backend: null, repo: path.join(workspaces, 'nope') }),
      /nope does not exist/,
    );
    await assert.rejects(
      jobs.createFromSession({ sessionId: 'loose-session', content: 'x', backend: null, repo: root }),
      /repo must be inside/,
    );
  });
});

test('a job whose repository is unusable is refused with a reason, not recorded for a failing fetch', async () => {
  await withWorkspace(async ({ root, jobs }) => {
    const workspaces = path.join(root, 'ws');
    await mkdir(path.join(workspaces, 'plain'), { recursive: true });
    await assert.rejects(jobs.create({ title: 'x', prompt: 'p', repoPath: path.join(workspaces, 'plain'), backend: null, baseBranch: null }), /plain is not a git repository/);
    await assert.rejects(jobs.create({ title: 'x', prompt: 'p', repoPath: path.join(workspaces, 'gone'), backend: null, baseBranch: null }), /gone does not exist/);
    assert.equal(jobs.list().length, 0);
  });
});

test('map preparation stays in preparing and gives the same optional query guidance to all backends', async () => {
  await withWorkspace(async ({ repo, config, runtime }) => {
    const releases: Array<(guidance: string) => void> = [];
    let preparingPath = '';
    const jobs = createJobsService({
      runtime: runtime.gateway,
      config: () => config,
      prepareProjectMap: (worktreePath) => {
        preparingPath = worktreePath;
        return new Promise<string>((resolve) => { releases.push(resolve); });
      },
    });
    for (const [index, backend] of (['claude', 'codex', 'glm'] as const).entries()) {
      const job = await jobs.create({ title: `map ${backend}`, prompt: 'investigate', repoPath: repo, backend, baseBranch: null });
      await eventually(() => releases.length === index + 1, 'map preparation');
      assert.equal(jobs.get(job.id)?.state, 'preparing');
      assert.equal(runtime.turns.length, index);
      assert.equal(preparingPath, job.worktree_path);
      releases[index]('Optional map: query relevant symbols; inspect exact source.');
      await eventually(() => runtime.turns.length === index + 1, 'first turn with guidance');
      assert.equal(jobs.get(job.id)?.state, 'active');
      assert.match(runtime.turns[index].command, /Optional map: query relevant symbols; inspect exact source\./);
      runtime.finish(runtime.turns[index].sessionId);
    }
  });
});

test('a finished job waits for the hub: tjob done parks it at review, tjob approve hands it to the queue', async () => {
  // hub-and-spoke (the user, 2026-10-27): a sub-agent's branch never reaches the base branch on its own
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    assert.equal(ctx.job(id).state, 'done');
    assert.equal(ctx.job(id).merge_step, 'review');
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'review');   // the queue leaves it alone
    const approved = await ctx.jobs.approve(id);
    assert.equal(approved.merge_step, 'queued');
    await assert.rejects(ctx.jobs.approve(id), /not waiting for review/);
  }, (config) => { config.review = true; });
});

test('the review gate is the default', () => {
  assert.equal(loadOrchestratorConfig('/nonexistent/orchestrator.json').review, true);
});
