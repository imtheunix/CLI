import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorEffectsDb, orchestratorJobsDb, readBackendHandovers, sessionsDb, userDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { createJobsService, mergeStepTimings } from '../services/jobs.service.js';
import { createMergeQueueService } from '../services/merge-queue.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import { checkEnvironment, resolveCheckCommand, runCommand } from '../services/workspace.service.js';
import { getHubEventsLogPath, onHubEvent } from '../services/hub-events.service.js';
import { buildHubWakeMessage, parseHubEventLine } from '../services/hub-wake.service.js';

type Turn = { sessionId: string; command: string; options: Record<string, unknown> };
type TurnWriter = { send: (message: NormalizedMessage) => void };

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
  const writers = new Map<string, TurnWriter>();
  const runtime = {
    turns,
    /** Each turn's run writer, for tests that speak for the provider. */
    writers,
    finish(sessionId: string, options: { aborted?: boolean; exitCode?: number } = {}) {
      chatRunRegistry.completeRun(sessionId, { exitCode: options.exitCode ?? 0, aborted: options.aborted });
      open.get(sessionId)?.();
    },
    gateway: {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
      abort: async (_provider: string, sessionId: string) => { open.get(sessionId)?.(); open.delete(sessionId); return true; },
      run: (_provider: string, command: string, options: Record<string, unknown>, writer: TurnWriter) => {
        const sessionId = String(options.sessionId);
        turns.push({ sessionId, command, options });
        writers.set(sessionId, writer);
        return new Promise<void>((resolve) => open.set(sessionId, resolve));
      },
    },
  };
  return runtime;
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
    createJobs: (overrides?: Partial<Parameters<typeof createJobsService>[0]>) => ReturnType<typeof createJobsService>;
    job: (id: string) => OrchestratorJobRow;
  }) => Promise<void>,
  tune: (config: OrchestratorConfig) => void = () => undefined,
  extraDeps: Partial<Parameters<typeof createJobsService>[0]> = {},
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
  const createJobs = (overrides: Partial<Parameters<typeof createJobsService>[0]> = {}) => {
    return createJobsService({
      runtime: runtime.gateway,
      config: () => config,
      probeZcode: async () => ({ ok: true }),
      ...extraDeps,
      ...overrides,
    });
  };
  const jobs = createJobs();
  const unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
  try {
    await runTest({ root, repo, upstream, config, runtime, jobs, createJobs, job: (id) => orchestratorJobsDb.get(id) as OrchestratorJobRow });
  } finally {
    unsubscribe();
    chatRunRegistry.clearAll();
    // The per-turn checkpoints run detached from the completion that started them;
    // let them finish before the test's repositories are removed.
    await jobs.afterCheckpoints().catch(() => {});
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

for (const [label, captureCheckpoint] of [
  ['rejects', async () => { throw new Error('injected checkpoint failure'); }],
  ['throws synchronously', () => { throw new Error('injected checkpoint failure'); }],
] as const) {
  test(`a turn-end checkpoint hook that ${label} never fails or blocks the job's turn`, async () => {
    let calls = 0;
    await withWorkspace(async ({ repo, jobs, runtime, job }) => {
      const created = await jobs.create({ title: 'ckpt', prompt: 'task', repoPath: repo, backend: 'claude', baseBranch: null });
      await eventually(() => runtime.turns.length === 1, 'first turn');
      const sessionId = job(created.id).session_id!;
      runtime.finish(sessionId);
      await jobs.afterCheckpoints();
      assert.equal(calls, 1, 'the hook ran once for the ended turn');
      const after = job(created.id);
      assert.equal(after.state, 'active');
      assert.equal(after.in_turn, 0);
      assert.equal(after.last_error, null);
      const rows = orchestratorEffectsDb.listByJob(created.id, 'checkpoint');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'failed');
      assert.equal(rows[0].blocking, 0);
      // The job takes its next turn as usual.
      assert.equal(await jobs.notify(after, 'next'), true);
      await eventually(() => runtime.turns.length === 2, 'next turn');
    }, undefined, { captureCheckpoint: (...args) => { calls += 1; return (captureCheckpoint as (...a: unknown[]) => Promise<unknown>)(...args); } });
  });
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
    // Jobs test only what they changed; the queue runs the gate once (the person, 2026-11-04).
    assert.match(turn.command, /Test only what you changed/);
    assert.match(turn.command, /Never run the whole test suite or the project's merge gate yourself/);
    assert.doesNotMatch(turn.command, /the project's checks pass/);
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

test('job guidance per repository from orchestrator.json is added to that repository job prompts', async () => {
  const guidance = 'Heavy work: run it with `tsge-compute run` from your worktree.\nNever run it directly on the workstation.';
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const created = await jobs.create({ title: 'guided', prompt: 'do guided', repoPath: repo, backend: null, baseBranch: null });
    await eventually(() => job(created.id).state === 'active', 'guided to start');
    const turn = runtime.turns.find((t) => t.sessionId === job(created.id).session_id)!;
    assert.match(turn.command, new RegExp(`For this repository \\(${path.basename(repo)}\\):`));
    assert.match(turn.command, /- Heavy work: run it with `tsge-compute run` from your worktree\./);
    assert.match(turn.command, /- Never run it directly on the workstation\./);
  }, (config) => { config.jobGuidance = { demo: guidance }; });
});

test('job guidance is read per repository from orchestrator.json, blank or non-text entries ignored', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestrator-config-'));
  try {
    const file = path.join(dir, 'orchestrator.json');
    assert.deepEqual(loadOrchestratorConfig(file).jobGuidance, {});
    writeFileSync(file, JSON.stringify({ jobGuidance: { tsge: '  Heavy work on the pool.  ', blank: '   ', wrong: 3 } }));
    assert.deepEqual(loadOrchestratorConfig(file).jobGuidance, { tsge: 'Heavy work on the pool.' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default model per backend and the peak-hours rule come from orchestrator.json, with no rebuild', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestrator-config-'));
  try {
    const file = path.join(dir, 'orchestrator.json');
    assert.equal(loadOrchestratorConfig(file).backends.glm.model, 'zai-coding-plan/glm-5.3-flash');
    assert.equal(loadOrchestratorConfig(file).backends.agy.cap, 4);
    assert.equal(loadOrchestratorConfig(file).glmQuotaFallback, 'agy');
    assert.equal(loadOrchestratorConfig(file).glmProvider, 'opencode');
    assert.equal(loadOrchestratorConfig(file).backends.zcode.model, 'GLM-5.3-Flash');
    assert.equal(loadOrchestratorConfig(file).backends.zcode.cap, 3);
    writeFileSync(file, JSON.stringify({ glmProvider: 'zcode' }));
    const zcodeConfig = loadOrchestratorConfig(file);
    assert.equal(zcodeConfig.glmProvider, 'zcode');
    assert.equal(zcodeConfig.backends.glm.provider, 'zcode');
    assert.equal(zcodeConfig.backends.glm.model, 'GLM-5.3-Flash');
    writeFileSync(file, JSON.stringify({ backends: { glm: { model: 'zai-coding-plan/glm-5.3' }, agy: { cap: 2 } }, glmQuotaFallback: 'wait', glmPeakHours: { avoid: false } }));
    const config = loadOrchestratorConfig(file);
    assert.equal(config.backends.glm.model, 'zai-coding-plan/glm-5.3');
    assert.equal(config.backends.glm.models['zai-coding-plan/glm-5.3-flash'], 'GLM Flash');
    assert.equal(config.backends.glm.cap, 3);
    assert.equal(config.backends.agy.cap, 2);
    assert.equal(config.glmQuotaFallback, 'wait');
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

test('cancelling a running job aborts its turn and refuses late completion', async () => {
  await withWorkspace(async ({ repo, runtime, jobs, job }) => {
    const created = await jobs.create({ title: 'cancel running', prompt: 'work', repoPath: repo, backend: 'agy', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'running turn');
    const sessionId = job(created.id).session_id!;
    await jobs.cancel(created.id);
    assert.equal(job(created.id).state, 'cancelled');
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);
    await assert.rejects(jobs.markDone(created.id), /not active/);
    await jobs.recover();
    assert.equal(runtime.turns.length, 1);
  });
});

test('finished cleanup waits for sessions, supports dry run, and recreates a cancelled worktree on resume', async () => {
  await withWorkspace(async ({ root, repo, runtime, jobs, job, config }) => {
    config.cleanup.buildDirs.demo = path.join(root, 'build', '{id}');
    const created = await jobs.create({ title: 'cleanup', prompt: 'work', repoPath: repo, backend: 'agy', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'running turn');
    const original = job(created.id);
    const build = path.join(root, 'build', created.id);
    await mkdir(build, { recursive: true });
    orchestratorJobsDb.update(created.id, { state: 'done', merge_step: 'merged' });
    assert.match((await jobs.sweepCleanup(true))[0].status, /busy/);
    assert.ok(existsSync(original.worktree_path));
    runtime.finish(original.session_id!);
    let preview = await jobs.sweepCleanup(true);
    for (let i = 0; i < 120 && preview[0].status === 'session busy; kept'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      preview = await jobs.sweepCleanup(true);
    }
    assert.equal(preview[0].status, 'would clean');
    assert.ok(existsSync(original.worktree_path) && existsSync(build));
    assert.equal((await jobs.sweepCleanup())[0].status, 'cleaned');
    assert.ok(!existsSync(original.worktree_path) && !existsSync(build));
    git(repo, 'rev-parse', '--verify', original.branch);

    orchestratorJobsDb.update(created.id, { state: 'cancelled', merge_step: 'none' });
    await jobs.resume(created.id);
    await eventually(() => job(created.id).state === 'active', 'resumed job');
    assert.ok(existsSync(original.worktree_path));
  });
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
  const env = checkEnvironment({ DATABASE_PATH: '/live/auth.db', NODE_ENV: 'production', CLAUDE_CLI_PATH: '/bin/claude', PLANS_CLIENT_SECRET: 's', CLI_HUB_EVENTS_LOG: '/home/x/.cache/cli/hub-events.log', HOME: '/home/x' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CLI_PATH', 'CLI_HUB_EVENTS_LOG', 'DATABASE_PATH', 'NODE_ENV', 'PLANS_CLIENT_SECRET']);
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
      return runCommand('git', ['-c', 'core.editor=true', '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '--continue'], { cwd, env: { ...process.env, GIT_EDITOR: 'true' } });
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

test('a check failing after 500 lines exposes the failing tail in the agent and hub messages and retains the full log', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f', 'feature'));
    assert.equal(ctx.jobs.get(id)!.checkLogPath, null);
    const reasons: string[] = [];
    const off = onHubEvent((event) => {
      if (event.jobId === id && event.state === 'merge_failed') reasons.push(event.reason);
    });
    try {
      const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
      await drain(queue, () => ctx.job(id), ['none']);
      const message = ctx.runtime.turns.at(-1)!.command;
      assert.match(message, /FAILED: final step/);
      assert.match(message, /Exit code: 23; duration: \d+ ms; timeout: no; signal: none/);
      assert.doesNotMatch(message, /Compiling 1\n/);
      const logPath = ctx.jobs.get(id)!.checkLogPath!;
      assert.ok(logPath.startsWith(path.join(ctx.config.worktreesRoot, 'demo', '.state', id)));
      assert.match(message, /Full check log:/);
      assert.ok(message.includes(logPath));
      const log = readFileSync(logPath, 'utf8');
      assert.equal(log.split('\n').length, 502);
      assert.match(log, /^Compiling 1\nCompiling 2\n/);
      assert.match(log, /Compiling 500\nFAILED: final step\n$/);
      assert.equal(git(ctx.job(id).worktree_path, 'status', '--porcelain'), '');
      assert.equal(reasons.length, 1);
      assert.ok(reasons[0].includes('FAILED: final step'));
      const event = readFileSync(getHubEventsLogPath(), 'utf8').trimEnd().split('\n')
        .map(parseHubEventLine).find((entry) => entry?.jobId === id && entry.state === 'merge_failed')!;
      assert.ok(event);
      const wake = buildHubWakeMessage([event]);
      assert.match(wake, /FAILED: final step/);
      assert.ok(wake.includes(logPath));
    } finally {
      off();
    }
  }, (config) => {
    config.checks = { demo: 'for i in {1..500}; do if ((i % 2)); then echo "Compiling $i"; else echo "Compiling $i" >&2; fi; done; echo "FAILED: final step"; exit 23' };
  });
});

for (const outcome of ['timeout', 'signal'] as const) {
  test(`a check terminated by ${outcome} reports its duration and termination details`, async () => {
    await withWorkspace(async (ctx) => {
      const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f', 'feature'));
      const queue = createMergeQueueService({
        jobs: ctx.jobs, config: () => ctx.config,
        // Avoid host login-shell startup consuming the fixture's short timeout.
        run: (command, args, options) => runCommand(command, command === 'nice' ? args.map((arg) => arg === '-lc' ? '-c' : arg) : args,
          command === 'nice' && outcome === 'timeout' ? { ...options!, timeoutMs: 1_000 } : options),
      });
      await drain(queue, () => ctx.job(id), ['none']);
      const message = ctx.runtime.turns.at(-1)!.command;
      assert.match(message, /Exit code: none \(terminated by signal\); duration: \d+ ms/);
      assert.ok(message.includes(outcome === 'timeout' ? 'timeout: yes (CHECK_TIMEOUT_MS=1200000); signal: SIGTERM' : 'timeout: no; signal: SIGTERM'));
      assert.match(message, /check started/);
      assert.match(readFileSync(ctx.jobs.get(id)!.checkLogPath!, 'utf8'), /check started/);
    }, (config) => {
      config.checks = { demo: outcome === 'timeout' ? 'echo "check started"; sleep 30' : 'echo "check started"; kill -TERM $$' };
    });
  });
}

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

/** A parent job with a commit on origin/<its branch>, out of the queue, and a finished child job based on that branch. */
async function stackedJobs(ctx: Parameters<Parameters<typeof withWorkspace>[0]>[0]) {
  const parent = await finishedJob(ctx, (worktree) => commitFile(worktree, 'parent.txt', 'p\n', 'parent'));
  orchestratorJobsDb.update(parent, { merge_step: 'none' });
  const parentRow = ctx.job(parent);
  git(parentRow.worktree_path, 'push', '-q', 'origin', `HEAD:refs/heads/${parentRow.branch}`);
  const created = await ctx.jobs.create({ title: 'child', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: parentRow.branch });
  await eventually(() => ctx.job(created.id).state === 'active', 'child start');
  commitFile(ctx.job(created.id).worktree_path, 'child.txt', 'c\n', 'child');
  ctx.runtime.finish(ctx.job(created.id).session_id!);
  await ctx.jobs.markDone(created.id);
  return { parent, child: created.id, parentBranch: parentRow.branch };
}

test('a job stacked on a cancelled job\'s branch is blocked, never merged into that dead branch (88328da6)', async () => {
  await withWorkspace(async (ctx) => {
    const { parent, child, parentBranch } = await stackedJobs(ctx);
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await queue.tick();
    await queue.tick();
    assert.equal(ctx.job(child).merge_step, 'queued', 'waits while its parent is on its way');

    orchestratorJobsDb.update(parent, { state: 'cancelled' });
    await drain(queue, () => ctx.job(child), ['merged', 'blocked']);
    assert.equal(ctx.job(child).merge_step, 'blocked');
    assert.match(ctx.job(child).last_error ?? '', /cancelled.*never reaches main/);
    assert.equal(ctx.job(child).pushed_sha, null);
    const parentTip = git(ctx.repo, 'ls-remote', 'origin', `refs/heads/${parentBranch}`).split('\t')[0];
    assert.equal(parentTip, git(ctx.job(parent).worktree_path, 'rev-parse', 'HEAD'), 'nothing pushed onto the parent branch');
  });
});

test('a job stacked on a merged job\'s branch lands on that job\'s base', async () => {
  await withWorkspace(async (ctx) => {
    const { parent, child } = await stackedJobs(ctx);
    git(ctx.job(parent).worktree_path, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    orchestratorJobsDb.update(parent, { merge_step: 'merged' });
    ctx.config.waitForDeploy = { demo: false };
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config });
    await drain(queue, () => ctx.job(child), ['merged', 'blocked']);
    assert.equal(ctx.job(child).merge_step, 'merged');
    assert.equal(ctx.job(child).base_branch, 'main');
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.ok(existsSync(path.join(ctx.upstream, 'child.txt')));
    assert.ok(existsSync(path.join(ctx.upstream, 'parent.txt')));
  });
});

test('a push that exits 0 but leaves the commit off origin/<base> blocks instead of merging', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    ctx.config.waitForDeploy = { demo: false };
    const run: typeof runCommand = async (command, args, options) =>
      command === 'git' && args[0] === 'push' ? { code: 0, stdout: '', stderr: 'Everything up-to-date' } : runCommand(command, args, options);
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config, run });
    await drain(queue, () => ctx.job(id), ['merged', 'blocked']);
    assert.equal(ctx.job(id).merge_step, 'blocked');
    assert.match(ctx.job(id).last_error ?? '', /is not on origin\/main afterwards/);
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

test('a run cancelled by a newer push follows the newer commit\'s run: running waits, success merges', async () => {
  await withWorkspace(async (ctx) => {
    writeFileSync(ctx.config.forgejo.tokenFile, 'test-token\n');
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    let newer = '';
    let newerStatus = 'running';
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      fetchJson: async () => ({ workflow_runs: [
        ...(newer ? [{ id: 761, workflow_id: 'ci.yml', commit_sha: newer, status: newerStatus }] : []),
        { id: 760, workflow_id: 'ci.yml', commit_sha: ctx.job(id).pushed_sha, status: 'cancelled' },
      ] }),
    });
    await drain(queue, () => ctx.job(id), ['deploy']);
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    commitFile(ctx.upstream, 'next.txt', 'n\n', 'next job');
    newer = git(ctx.upstream, 'rev-parse', 'HEAD');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');

    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'deploy');
    newerStatus = 'success';
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');
    assert.match(ctx.job(id).last_error!, /ci\.yml#761: success/);
  });
});

test('a run cancelled by a newer push blocks when the newer commit\'s run fails', async () => {
  await withWorkspace(async (ctx) => {
    writeFileSync(ctx.config.forgejo.tokenFile, 'test-token\n');
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    let newer = '';
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      fetchJson: async () => ({ workflow_runs: [
        { id: 761, workflow_id: 'ci.yml', commit_sha: newer, status: 'failure' },
        { id: 760, workflow_id: 'ci.yml', commit_sha: ctx.job(id).pushed_sha, status: 'cancelled' },
      ] }),
    });
    await drain(queue, () => ctx.job(id), ['deploy']);
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    commitFile(ctx.upstream, 'next.txt', 'n\n', 'next job');
    newer = git(ctx.upstream, 'rev-parse', 'HEAD');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');

    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'blocked');
    assert.match(ctx.job(id).last_error!, /ci\.yml#760: cancelled \(superseded by \w{8}, whose run failed: ci\.yml#761: failure\)/);
  });
});

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
  await withWorkspace(async ({ repo, config, runtime, createJobs }) => {
    const releases: Array<(guidance: string) => void> = [];
    let preparingPath = '';
    const jobs = createJobs({
      prepareProjectMap: (worktreePath) => {
        preparingPath = worktreePath;
        return new Promise<string>((resolve) => { releases.push(resolve); });
      },
    });
    for (const [index, backend] of (['claude', 'codex', 'glm', 'agy'] as const).entries()) {
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

test('job branches are feature/… by default and bugfix/… on request', async () => {
  // the user, 2026-11-01: work lands in a feature/bugfix branch, reviewed by the hub before main
  await withWorkspace(async (ctx) => {
    const feature = await ctx.jobs.create({ title: 'Add a thing', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
    assert.match(ctx.job(feature.id).branch, /^feature\/add-a-thing-[0-9a-f]{8}$/);
    const bugfix = await ctx.jobs.create({ title: 'Fix a thing', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null, kind: 'bugfix' });
    assert.match(ctx.job(bugfix.id).branch, /^bugfix\/fix-a-thing-[0-9a-f]{8}$/);
    // let both jobs finish starting (worktree creation) before the workspace is removed
    await eventually(() => ctx.job(feature.id).state === 'active' && ctx.job(bugfix.id).state === 'active', 'start');
  });
});

test('waitForDeploy overrides are keyed by repository and default to waiting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestrator-config-'));
  try {
    const file = path.join(dir, 'orchestrator.json');
    assert.deepEqual(loadOrchestratorConfig(file).waitForDeploy, {});
    writeFileSync(file, '{invalid');
    assert.deepEqual(loadOrchestratorConfig(file).waitForDeploy, {});
    writeFileSync(file, JSON.stringify({ waitForDeploy: { tsge: false, tribeira: true } }));
    const config = loadOrchestratorConfig(file);
    assert.equal(config.waitForDeploy.tripam ?? true, true);
    assert.deepEqual(config.waitForDeploy, { tsge: false, tribeira: true });
    assert.ok(config.checks.tribeiracli);
    writeFileSync(file, JSON.stringify({ waitForDeploy: { tsge: true } }));
    assert.deepEqual(loadOrchestratorConfig(file).waitForDeploy, { tsge: true });
    writeFileSync(file, JSON.stringify({ waitForDeploy: null }));
    assert.deepEqual(loadOrchestratorConfig(file).waitForDeploy, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a no-wait repository pushes two queued jobs and immediately merges both without watching CI', async () => {
  await withWorkspace(async (ctx) => {
    const first = await finishedJob(ctx, (worktree) => commitFile(worktree, 'a.txt', 'a', 'a'));
    const second = await finishedJob(ctx, (worktree) => commitFile(worktree, 'b.txt', 'b', 'b'));
    let pushes = 0;
    let requests = 0;
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      run: async (command, args, options) => {
        if (command === 'git' && args[0] === 'push') pushes += 1;
        return runCommand(command, args, options);
      },
      fetchJson: async () => { requests += 1; throw new Error('CI must not be watched'); },
    });
    for (let i = 0; i < 20 && [first, second].some((id) => ctx.job(id).merge_step !== 'merged'); i += 1) {
      await queue.tick();
      assert.ok([first, second].every((id) => ctx.job(id).merge_step !== 'deploy'));
    }
    assert.equal(pushes, 2);
    assert.equal(requests, 0);
    for (const id of [first, second]) {
      const job = ctx.job(id);
      assert.equal(job.state, 'done'); // tjob displays done + merged as ci:merged
      assert.equal(job.merge_step, 'merged');
      assert.equal(job.last_error, `pushed ${job.pushed_sha}; CI runs after merge, not awaited`);
      assert.equal(job.deploy_waiting_since, null);
    }
    git(ctx.upstream, 'pull', '-q', 'origin', 'main');
    assert.ok(existsSync(path.join(ctx.upstream, 'a.txt')));
    assert.ok(existsSync(path.join(ctx.upstream, 'b.txt')));
  }, (config) => { config.waitForDeploy = { demo: false }; });
});

test('a push does not wait for another job\'s deploy in the same repository', async () => {
  await withWorkspace(async (ctx) => {
    const first = await finishedJob(ctx, (worktree) => commitFile(worktree, 'a.txt', 'a', 'a'));
    const second = await finishedJob(ctx, (worktree) => commitFile(worktree, 'b.txt', 'b', 'b'));
    writeFileSync(ctx.config.forgejo.tokenFile, 'test-token');
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      fetchJson: async () => ({ workflow_runs: [{ commit_sha: ctx.job(first).pushed_sha, status: 'running' }] }),
    });
    await drain(queue, () => ctx.job(first), ['deploy']);
    await drain(queue, () => ctx.job(second), ['deploy']);
    // The first deploy is still running; the second job pushed on top of it all the same.
    assert.equal(ctx.job(first).merge_step, 'deploy');
    assert.equal(ctx.job(second).merge_step, 'deploy');
    assert.equal(git(ctx.upstream, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], ctx.job(second).pushed_sha);
  });
});

test('a no-wait repository recovers an unrecorded push without pushing twice', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f', 'feature'));
    const worktree = ctx.job(id).worktree_path;
    git(worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    orchestratorJobsDb.update(id, { merge_step: 'push' });
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      run: async (command, args, options) => {
        assert.ok(command !== 'git' || args[0] !== 'push');
        return runCommand(command, args, options);
      },
    });
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');
    assert.equal(ctx.job(id).pushed_sha, git(worktree, 'rev-parse', 'HEAD'));
    assert.equal(ctx.job(id).last_error, `pushed ${ctx.job(id).pushed_sha}; CI runs after merge, not awaited`);
  }, (config) => { config.waitForDeploy = { demo: false }; });
});

test('disabling deploy waiting releases an already pushed job without watching CI', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'a.txt', 'a', 'a'));
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      fetchJson: async () => { throw new Error('CI must not be watched'); },
    });
    await drain(queue, () => ctx.job(id), ['deploy']);
    assert.equal(ctx.job(id).merge_step, 'deploy');
    ctx.config.waitForDeploy.demo = false;
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');
    assert.equal(ctx.job(id).last_error, `pushed ${ctx.job(id).pushed_sha}; CI runs after merge, not awaited`);
  });
});

test('quota-stopped GLM work continues in a new agy session on the same dirty branch', async () => {
  await withWorkspace(async ({ repo, jobs, runtime, job, config, createJobs }) => {
    const created = await jobs.create({ title: 'quota', prompt: 'Implement the original task', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'GLM turn');
    const before = job(created.id);
    writeFileSync(path.join(before.worktree_path, 'unfinished.txt'), 'keep this work');
    const run = chatRunRegistry.getRun(before.session_id!)!;
    run.writer.send({ kind: 'error', provider: 'opencode', content: 'Usage limit reached for 5 hour.' });
    runtime.finish(before.session_id!); // OpenCode may exit zero even after APIError.
    assert.equal(job(created.id).state, 'queued');
    assert.ok(jobs.backendStatus().glm);
    // A service recreation sees the persisted cooldown, too.
    const recovered = createJobs();
    assert.equal(recovered.backendStatus().glm, jobs.backendStatus().glm);
    config.backends.agy.cap = 0;
    await recovered.tick();
    assert.equal(job(created.id).state, 'queued');
    assert.equal(runtime.turns.length, 1);
    config.backends.agy.cap = 4;
    await recovered.tick();
    await eventually(() => runtime.turns.length === 2, 'agy continuation');
    const after = job(created.id);
    assert.equal(after.backend, 'agy');
    assert.equal(after.model, 'gemini-3.8-flash-medium');
    assert.notEqual(after.session_id, before.session_id);
    assert.equal(after.worktree_path, before.worktree_path);
    assert.equal(after.branch, before.branch);
    assert.equal(readFileSync(path.join(after.worktree_path, 'unfinished.txt'), 'utf8'), 'keep this work');
    assert.equal(sessionsDb.getSessionById(after.session_id!)?.provider, 'agy');
    assert.ok(sessionsDb.getSessionById(before.session_id!));
    assert.match(runtime.turns[1].command, /Implement the original task/);
    assert.match(runtime.turns[1].command, /Another model started this job and stopped at its quota; read `git log`, `git status` and the diff, then continue from where it stopped/);
    assert.equal(runtime.turns[1].options.permissionMode, 'bypassPermissions');
    const next = await recovered.create({ title: 'next', prompt: 'next task', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => job(next.id).state === 'active', 'new fallback job');
    assert.equal(job(next.id).backend, 'agy');
    assert.equal(recovered.get(next.id)?.quotaFallback, true);
  });
});

test('wait mode keeps quota-stopped jobs queued until reset and ignores aborted errors', async () => {
  await withWorkspace(async ({ repo, jobs, runtime, job, config, createJobs }) => {
    config.glmQuotaFallback = 'wait';
    const created = await jobs.create({ title: 'wait', prompt: 'task', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'GLM turn');
    const sessionId = job(created.id).session_id!;
    chatRunRegistry.getRun(sessionId)!.writer.send({ kind: 'error', provider: 'opencode', content: 'Usage limit reached for 5 hour.' });
    runtime.finish(sessionId, { aborted: true });
    assert.equal(jobs.backendStatus().glm, null);
    jobs.handleRunCompleted({ appSessionId: sessionId, exitCode: 1, aborted: false });
    assert.equal(job(created.id).state, 'queued');
    await jobs.tick();
    assert.equal(job(created.id).state, 'queued');
    assert.equal(runtime.turns.length, 1);
    const afterReset = createJobs({ now: () => new Date(Date.now() + 3_700_000) });
    assert.equal(afterReset.backendStatus().glm, null);
    await afterReset.tick();
    await eventually(() => runtime.turns.length === 2, 'GLM after reset');
    assert.equal(job(created.id).backend, 'glm');
    assert.equal(job(created.id).session_id, sessionId);
  });
});

test('a usage-limited claude job resumes its own session at the stated reset, once, even across a restart', async () => {
  await withWorkspace(async ({ repo, jobs, runtime, job, config, createJobs }) => {
    const created = await jobs.create({ title: 'limited', prompt: 'task', repoPath: repo, backend: 'claude', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'claude turn');
    const sessionId = job(created.id).session_id!;
    // Claude's SDK marks the limit message with error: 'rate_limit' (text recorded 2026-11-03); the turn exits 0.
    chatRunRegistry.getRun(sessionId)!.writer.send({ kind: 'error', provider: 'claude', errorCode: 'rate_limit', content: "You've hit your session limit · resets 3am (America/Sao_Paulo)" });
    runtime.finish(sessionId);
    const limited = job(created.id);
    assert.equal(limited.state, 'active');
    assert.equal(limited.failure_class, 'usage_limit');
    assert.ok(limited.resume_at && Date.parse(limited.resume_at) > Date.now());
    const armed = limited.limit_recovery;
    assert.deepEqual(jobs.get(created.id)?.limitWait, { failureClass: 'usage_limit', resumesAt: limited.resume_at, waitsForHub: false });
    // The same failed turn reported twice arms nothing new.
    jobs.handleRunCompleted({ appSessionId: sessionId, exitCode: 0, aborted: false });
    assert.equal(job(created.id).limit_recovery, armed);
    await jobs.tick();
    assert.equal(runtime.turns.length, 1);

    // A restarted server (new service) reads the persisted recovery and resumes after the reset.
    const resumeAt = Date.parse(limited.resume_at!);
    const restarted = createJobs({ now: () => new Date(resumeAt + 1_000) });
    await restarted.tick();
    await eventually(() => runtime.turns.length === 2, 'continue turn');
    assert.equal(runtime.turns[1].sessionId, sessionId);
    assert.equal(runtime.turns[1].command, 'Continue where you left off.');
    await restarted.tick();
    assert.equal(runtime.turns.length, 2);
    runtime.finish(sessionId);
    assert.equal(job(created.id).failure_class, null);
    assert.equal(job(created.id).limit_recovery, null);
  });
});

test('limit text in assistant prose or a failing test does not arm a recovery', async () => {
  await withWorkspace(async ({ repo, jobs, runtime, job }) => {
    const created = await jobs.create({ title: 'prose', prompt: 'task', repoPath: repo, backend: 'codex', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'codex turn');
    const sessionId = job(created.id).session_id!;
    const writer = chatRunRegistry.getRun(sessionId)!.writer;
    writer.send({ kind: 'text', provider: 'codex', content: 'You’ve hit your usage limit. Try again at 10:47 AM.' });
    writer.send({ kind: 'error', provider: 'codex', content: 'FAIL test: expected "You have hit your usage limit" to equal "ok"' });
    runtime.finish(sessionId, { exitCode: 1 });
    assert.equal(job(created.id).failure_class, null);
    assert.equal(job(created.id).limit_recovery, null);
    assert.equal(job(created.id).last_error, 'The last turn ended with exit code 1');
  });
});

test('a job needing a login waits, wakes the hub once, and resumes when the login probe passes', async () => {
  await withWorkspace(async ({ repo, runtime, job, config, createJobs }) => {
    const events: string[] = [];
    const stopListening = onHubEvent((event) => events.push(`${event.state}:${event.reason}`));
    let loggedIn = false;
    let clock = Date.now();
    const jobs = createJobs({ now: () => new Date(clock), probeAuth: async () => loggedIn });
    const unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
    try {
      const created = await jobs.create({ title: 'login', prompt: 'task', repoPath: repo, backend: 'claude', baseBranch: null });
      await eventually(() => runtime.turns.length === 1, 'claude turn');
      const sessionId = job(created.id).session_id!;
      chatRunRegistry.getRun(sessionId)!.writer.send({ kind: 'error', provider: 'claude', content: 'Login expired · Please run /login' });
      runtime.finish(sessionId, { exitCode: 1 });
      assert.equal(job(created.id).failure_class, 'auth_required');
      assert.deepEqual(jobs.get(created.id)?.limitWait, { failureClass: 'auth_required', resumesAt: null, waitsForHub: false });
      assert.equal(events.filter((event) => event.startsWith('waiting:login needed')).length, 1);
      clock += 10 * 60_000;
      await jobs.tick();   // probe fails: no turn, next probe in 10 min
      assert.equal(runtime.turns.length, 1);
      loggedIn = true;
      await jobs.tick();   // not yet due again
      assert.equal(runtime.turns.length, 1);
      clock += 10 * 60_000;
      await jobs.tick();
      await eventually(() => runtime.turns.length === 2, 'continue after login');
      assert.equal(runtime.turns[1].command, 'Continue where you left off.');
      assert.equal(events.length, 1);
    } finally {
      unsubscribe();
      stopListening();
    }
  });
});

test('the light gate: configured, then merge-gate.sh, then a fast check per stack, check.sh last', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'light-gate-'));
  try {
    const resolve = async (files: Record<string, string>, configured: Record<string, string> = {}) => {
      const dir = await mkdtemp(path.join(root, 'repo-'));
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), content);
      }
      return resolveCheckCommand(path.join(root, 'demo'), dir, configured);
    };
    const npm = (scripts: Record<string, string>) => JSON.stringify({ scripts });
    assert.equal(await resolve({ 'scripts/merge-gate.sh': '' }, { demo: 'make quick' }), 'make quick');
    assert.equal(await resolve({ 'scripts/merge-gate.sh': '', 'package.json': npm({ lint: 'eslint' }) }), 'scripts/merge-gate.sh');
    assert.equal(
      await resolve({ 'package.json': npm({ typecheck: 'tsc', lint: 'eslint', test: 'vitest run', check: 'npm test' }) }),
      'npm run typecheck && npm run lint',
    );
    assert.equal(await resolve({ 'package.json': npm({ lint: 'eslint', test: 'vitest run' }) }), 'npm run lint');
    // Only the suite: no npm gate (never `npm test`); a lighter stack or check.sh is used, else nothing.
    assert.equal(await resolve({ 'package.json': npm({ test: 'vitest run', check: 'npm test' }) }), null);
    assert.equal(await resolve({ 'package.json': npm({ test: 'vitest' }), 'scripts/check.sh': '' }), 'scripts/check.sh');
    assert.equal(await resolve({ 'pom.xml': '' }), 'mvn -q -o test-compile || mvn -q test-compile');
    assert.equal(await resolve({ 'Cargo.toml': '', 'scripts/check.sh': '' }), 'cargo check --all-targets --quiet');
    assert.equal(await resolve({ 'requirements.txt': '' }), 'python -m pytest --collect-only -q');
    assert.equal(
      await resolve({ 'pyproject.toml': '[project]\nname = "x"\n', 'scripts/hermes-env.sh': '' }),
      'scripts/hermes-env.sh python -m pytest --collect-only -q',
    );
    assert.equal(
      await resolve({ 'pyproject.toml': '[tool.ruff]\nline-length = 120\n' }),
      'python -m pytest --collect-only -q && python -m ruff check .',
    );
    assert.equal(await resolve({ 'scripts/check.sh': '' }), 'scripts/check.sh');
    assert.equal(await resolve({}), null);
    assert.equal(loadOrchestratorConfig(path.join(root, 'none.json')).checks.tribeiracli, 'npm run typecheck && npm run lint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maxConcurrentChecks defaults to 1 and takes a positive override', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'check-slots-'));
  try {
    const file = path.join(root, 'orchestrator.json');
    assert.equal(loadOrchestratorConfig(file).maxConcurrentChecks, 1);
    writeFileSync(file, JSON.stringify({ maxConcurrentChecks: 3 }));
    assert.equal(loadOrchestratorConfig(file).maxConcurrentChecks, 3);
    writeFileSync(file, JSON.stringify({ maxConcurrentChecks: 0 }));
    assert.equal(loadOrchestratorConfig(file).maxConcurrentChecks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one merge check at a time on the workstation, run under nice; the others wait in check', async () => {
  await withWorkspace(async (ctx) => {
    const first = await finishedJob(ctx, (worktree) => commitFile(worktree, 'a.txt', 'a', 'a'));
    const second = await finishedJob(ctx, (worktree) => commitFile(worktree, 'b.txt', 'b', 'b'));
    // Two repositories' jobs at their check at once (the lane is per repository).
    orchestratorJobsDb.update(first, { merge_step: 'check' });
    orchestratorJobsDb.update(second, { merge_step: 'check' });
    const checks: Array<{ argv: string[]; release: () => void }> = [];
    const queue = createMergeQueueService({
      jobs: ctx.jobs, config: () => ctx.config,
      run: async (command, args, options) => {
        if (command !== 'nice') return runCommand(command, args, options);
        await new Promise<void>((release) => checks.push({ argv: [command, ...args], release }));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const firstPass = queue.tick();
    await eventually(() => checks.length === 1, 'the first check');
    assert.deepEqual(checks[0].argv, ['nice', '-n', '10', '/bin/bash', '-lc', 'true']);
    await queue.tick(); // the other job finds no free slot
    assert.equal(checks.length, 1);
    assert.deepEqual([ctx.job(first).merge_step, ctx.job(second).merge_step], ['check', 'check']);

    checks[0].release();
    await firstPass;
    const secondPass = queue.tick();
    await eventually(() => checks.length === 2, 'the second check');
    checks[1].release();
    await secondPass;
    assert.ok([first, second].every((id) => ctx.job(id).merge_step !== 'check'));
  });
});

test('each merge step\'s start is recorded, and the job view shows how long each took', async () => {
  await withWorkspace(async (ctx) => {
    const id = await finishedJob(ctx, (worktree) => commitFile(worktree, 'feature.txt', 'f\n', 'feature'));
    let clock = Date.now();
    const queue = createMergeQueueService({ jobs: ctx.jobs, config: () => ctx.config, now: () => clock });
    await drain(queue, () => ctx.job(id), ['deploy']);
    clock += 10 * 60_000;
    await queue.tick();
    assert.equal(ctx.job(id).merge_step, 'merged');

    const view = ctx.jobs.get(id)!;
    assert.deepEqual(view.mergeSteps.map((entry) => entry.step), ['queued', 'rebase', 'check', 'check:run', 'push', 'deploy', 'merged']);
    assert.ok(view.mergeSteps.slice(0, -1).every((entry) => typeof entry.durationMs === 'number' && entry.durationMs >= 0));
    assert.equal(view.mergeSteps.at(-1)!.durationMs, null);

    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 3, 12, 0, seconds)).toISOString();
    assert.deepEqual(mergeStepTimings([
      { step: 'rebase', at: at(0) }, { step: 'check', at: at(5) }, { step: 'check:run', at: at(20) },
    ], Date.parse(at(50))).map((entry) => entry.durationMs), [5000, 15000, 30000]);
  });
});

/**
 * Claude Code re-invokes the model when background work a turn started
 * reports back, after that turn's `result`; the runtime then tells the run it
 * is working again (a `turnResumed` status) and completes it once more on the
 * next `result` (provider side: claude-turn-resumed.test.ts). The job must
 * show working again and each end must reach the hub, as often as it
 * happens. Seen live on TSGE job 241870f9: one turn_ended, then 20 more
 * minutes of work and a final report the hub never heard of.
 */
test('a claude turn that goes on after its result is working again, and each of its ends wakes the hub', async () => {
  const previousLog = process.env.CLI_HUB_EVENTS_LOG;
  const logDir = await mkdtemp(path.join(tmpdir(), 'hub-events-'));
  const log = path.join(logDir, 'hub-events.log');
  process.env.CLI_HUB_EVENTS_LOG = log;
  const turnEnds = (jobId: string) => (existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter((line) => line.split('\t')[1] === jobId && line.split('\t')[2] === 'turn_ended').length
    : 0);

  try {
    await withWorkspace(async ({ repo, runtime, jobs }) => {
      const created = await jobs.create({ title: 'resumed', prompt: 'do it', repoPath: repo, backend: 'claude', baseBranch: null });
      await eventually(() => runtime.turns.length === 1, 'the turn to start');
      const sessionId = runtime.turns[0].sessionId;
      const writer = runtime.writers.get(sessionId)!;
      const say = (message: Partial<NormalizedMessage>) => writer.send({ provider: 'claude', sessionId: 'native-1', ...message } as NormalizedMessage);
      const states: Array<string | null> = [];
      const ends: number[] = [];
      const look = () => { states.push(jobs.get(created.id)!.activity); ends.push(turnEnds(created.id)); };

      // What the Claude runtime sends for: assistant, result, (task reports in) assistant, result, assistant, result.
      say({ kind: 'text', role: 'assistant', content: 'Started the workflow.' });
      look();
      for (let resumed = 0; resumed < 2; resumed += 1) {
        say({ kind: 'complete', exitCode: 0 });
        look();
        say({ kind: 'status', text: 'Working on background results', turnResumed: true, canInterrupt: true });
        say({ kind: 'text', role: 'assistant', content: 'Final report.' });
        look();
      }
      say({ kind: 'complete', exitCode: 0 });
      look();

      assert.deepEqual(states, ['working', 'waiting', 'working', 'waiting', 'working', 'waiting']);
      assert.deepEqual(ends, [0, 1, 1, 2, 2, 3], 'one turn_ended (one hub wake) per end');
      runtime.finish(sessionId);
    });
  } finally {
    if (previousLog === undefined) delete process.env.CLI_HUB_EVENTS_LOG;
    else process.env.CLI_HUB_EVENTS_LOG = previousLog;
    await rm(logDir, { recursive: true, force: true });
  }
});

test('jobs with backend: zcode launch with GLM-5.3-Flash and participate in quota fallback', async () => {
  await withWorkspace(async ({ repo, jobs, runtime, job }) => {
    const created = await jobs.create({ title: 'zcode task', prompt: 'Do something with zcode', repoPath: repo, backend: 'zcode', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'zcode turn');
    const before = job(created.id);
    assert.equal(before.backend, 'zcode');
    assert.equal(before.model, 'GLM-5.3-Flash');
    assert.equal(runtime.turns[0].options.model, 'GLM-5.3-Flash');

    // Quota exhaustion 1310 triggers agy fallback
    const run = chatRunRegistry.getRun(before.session_id!)!;
    run.writer.send({ kind: 'error', provider: 'zcode', content: '[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-07 12:28:03]' });
    runtime.finish(before.session_id!);
    assert.equal(job(created.id).state, 'queued');

    await jobs.tick();
    await eventually(() => runtime.turns.length === 2, 'agy continuation from zcode');
    const after = job(created.id);
    assert.equal(after.backend, 'agy');
  });
});

test('orchestrator test harness injects a healthy probeZcode stub by default across service recreations', async () => {
  await withWorkspace(async ({ createJobs, repo, runtime, job }) => {
    // A service recreation without explicit probeZcode inherits the healthy test stub
    const service = createJobs();
    const created = await service.create({ title: 'harness-probe-stub', prompt: 'test', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => runtime.turns.length === 1, 'turn dispatch with default harness probe');
    assert.equal(job(created.id).state, 'active');
    assert.equal(job(created.id).backend, 'glm');
    assert.equal(job(created.id).failure_class, null);
  });
});

// codexQuotaFallback (the person, 2026-11-07: "when Terra is out of quota replace it with GLM flash").
const CODEX_LIMIT = 'You’ve hit your usage limit. Upgrade to Pro or try again at Nov 9th, 2099 10:36 AM.';

async function limitCodexTurn(
  ctx: { repo: string; jobs: ReturnType<typeof createJobsService>; runtime: ReturnType<typeof createRuntime>; job: (id: string) => OrchestratorJobRow },
): Promise<{ id: string; codexSession: string }> {
  const created = await ctx.jobs.create({ title: 'terra', prompt: 'build the widget', repoPath: ctx.repo, backend: 'codex', baseBranch: null });
  await eventually(() => ctx.runtime.turns.length === 1, 'codex turn');
  const codexSession = ctx.job(created.id).session_id!;
  commitFile(ctx.job(created.id).worktree_path, 'widget.txt', 'half\n', 'feat: half of the widget');
  const writer = chatRunRegistry.getRun(codexSession)!.writer;
  writer.send({ kind: 'text', role: 'assistant', provider: 'codex', content: 'Step 1 of the widget is committed; step 2 is next.' });
  writer.send({ kind: 'error', provider: 'codex', content: CODEX_LIMIT });
  ctx.runtime.finish(codexSession, { exitCode: 1 });
  return { id: created.id, codexSession };
}

test('a usage-limited codex job is handed to GLM Flash once: same job, worktree and branch, with a handover prompt', async () => {
  await withWorkspace(async (ctx) => {
    const { jobs, runtime, job } = ctx;
    const { id, codexSession } = await limitCodexTurn(ctx);
    // The same failed turn reported again while the handover runs: still one handover.
    jobs.handleRunCompleted({ appSessionId: codexSession, exitCode: 1, aborted: false });
    await jobs.afterHandovers();
    await eventually(() => runtime.turns.length === 2, 'GLM Flash turn');
    const moved = job(id);
    assert.equal(moved.backend, 'glm');
    assert.equal(moved.model, 'zai-coding-plan/glm-5.3-flash');
    assert.equal(moved.state, 'active');
    assert.notEqual(moved.session_id, codexSession);
    assert.equal(moved.branch, `feature/terra-${id}`);
    assert.ok(moved.worktree_path.endsWith(id));
    assert.equal(moved.failure_class, null);
    assert.equal(moved.limit_recovery, null);
    const history = readBackendHandovers(moved);
    assert.equal(history.length, 1);
    assert.equal(history[0].fromBackend, 'codex');
    assert.equal(history[0].fromSessionId, codexSession);
    assert.equal(history[0].toModel, 'zai-coding-plan/glm-5.3-flash');
    assert.equal(history[0].reason, 'quota');
    assert.ok(history[0].resetAt?.startsWith('2099-11-09'));
    const turn = runtime.turns[1];
    assert.equal(turn.sessionId, moved.session_id);
    assert.equal(turn.options.model, 'zai-coding-plan/glm-5.3-flash');
    assert.match(turn.command, /build the widget/);
    assert.match(turn.command, /previous agent on this job \(codex\) hit its usage limit/);
    assert.match(turn.command, /Step 1 of the widget is committed; step 2 is next\./);
    assert.match(turn.command, /feat: half of the widget/);
    assert.match(turn.command, /Continue where the previous agent stopped\./);
    const shown = jobs.get(id)!;
    assert.equal(shown.handover, 'codex->glm (quota)');
    assert.deepEqual(shown.usageByBackend?.map((entry) => [entry.backend, entry.sessionId]), [['codex', codexSession], ['glm', moved.session_id]]);
    // The Codex turn reported once more after the move: nothing new.
    jobs.handleRunCompleted({ appSessionId: codexSession, exitCode: 1, aborted: false });
    await jobs.afterHandovers();
    await jobs.tick();
    assert.equal(readBackendHandovers(job(id)).length, 1);
    assert.equal(runtime.turns.length, 2);
  }, (config) => { config.codexQuotaFallback = 'glm-flash'; });
});

test('a usage-limited codex job waits for its reset when no GLM slot is free', async () => {
  await withWorkspace(async (ctx) => {
    const { id } = await limitCodexTurn(ctx);
    await ctx.jobs.afterHandovers();
    const waiting = ctx.job(id);
    assert.equal(waiting.backend, 'codex');
    assert.equal(waiting.failure_class, 'usage_limit');
    // A reset more than 24 h away: today's recovery waits for the hub.
    assert.equal(ctx.jobs.get(id)?.limitWait?.waitsForHub, true);
    assert.equal(waiting.backend_history, null);
    assert.equal(ctx.runtime.turns.length, 1);
  }, (config) => { config.codexQuotaFallback = 'glm-flash'; config.backends.glm.cap = 0; });
});

test('a usage-limited codex job waits for its reset when the ZCode login probe fails', async () => {
  let probes = 0;
  await withWorkspace(async (ctx) => {
    const { id } = await limitCodexTurn(ctx);
    await ctx.jobs.afterHandovers();
    assert.equal(probes, 1);
    const waiting = ctx.job(id);
    assert.equal(waiting.backend, 'codex');
    assert.equal(waiting.failure_class, 'usage_limit');
    assert.equal(waiting.backend_history, null);
    assert.equal(ctx.jobs.get(id)?.handover, null);
    assert.equal(ctx.runtime.turns.length, 1);
  }, (config) => { config.codexQuotaFallback = 'glm-flash'; }, {
    probeZcode: async () => { probes += 1; return { ok: false, error: 'login_failed', message: 'project_token_login_failed' }; },
  });
});

test('with codexQuotaFallback unset, a usage-limited codex job waits for its reset', async () => {
  await withWorkspace(async (ctx) => {
    assert.equal(ctx.config.codexQuotaFallback, 'wait');
    const { id } = await limitCodexTurn(ctx);
    await ctx.jobs.afterHandovers();
    assert.equal(ctx.job(id).backend, 'codex');
    assert.equal(ctx.job(id).failure_class, 'usage_limit');
    assert.equal(ctx.runtime.turns.length, 1);
  });
});
