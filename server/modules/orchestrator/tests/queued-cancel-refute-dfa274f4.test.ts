// Independent refutation probes for the merged queued-job cancellation feature
// (346febf2 + fix 127a8543; review job dfa274f4, producer job a84d0596).
//
// Every probe drives the real wired composition — a jobs service whose
// `withdrawFromMergeQueue` is a real merge queue's `cancel`, exactly like
// orchestrator.module.ts wires it — against an isolated temporary database,
// bare origin and worktrees. No production state, no network, no CI: the
// Forgejo token file points nowhere, so a pushed job merges without CI, and
// the check and conflict-resolver commands are fixture-owned children held on
// controlled events, never sleeps.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorEffectsDb, orchestratorJobsDb, readMergeStepHistory, userDb } from '@/modules/database/index.js';
import type { OrchestratorEffectRow, OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { createEffectOutbox } from '../services/effect-outbox.service.js';
import { createJobsService, mergeStepTimings } from '../services/jobs.service.js';
import { createMergeQueueService } from '../services/merge-queue.service.js';
import { computeMorphUsage } from '../services/morph-usage.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import { getCheckLogPath, runCommand } from '../services/workspace.service.js';
import type { CommandResult } from '../services/workspace.service.js';
import { onHubEvent } from '../services/hub-events.service.js';
import { formatHubEventStateDescription } from '../services/hub-wake.service.js';

type Turn = { sessionId: string; command: string; options: Record<string, unknown> };
type TurnWriter = { send: (message: NormalizedMessage) => void };
type Queue = ReturnType<typeof createMergeQueueService>;
type Jobs = ReturnType<typeof createJobsService>;
type Outbox = ReturnType<typeof createEffectOutbox>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A git exit code, for commands whose failure is the expected answer (merge-base --is-ancestor). */
function gitCode(cwd: string, ...args: string[]): number {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A provider runtime whose turns stay open until the probe ends them, like a real agent's. */
function createRuntime() {
  const turns: Turn[] = [];
  const open = new Map<string, () => void>();
  const runtime = {
    turns,
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
      run: (_provider: string, command: string, options: Record<string, unknown>, _writer: TurnWriter) => {
        const sessionId = String(options.sessionId);
        turns.push({ sessionId, command, options });
        return new Promise<void>((resolve) => open.set(sessionId, resolve));
      },
    },
  };
  return runtime;
}

type Fixture = {
  root: string;
  repo: string;
  upstream: string;
  origin: string;
  config: OrchestratorConfig;
  runtime: ReturnType<typeof createRuntime>;
  outbox: Outbox;
  queue: Queue;
  jobs: Jobs;
  createJobs: (overrides?: Partial<Parameters<typeof createJobsService>[0]>) => Jobs;
  createQueue: (overrides?: Partial<Parameters<typeof createMergeQueueService>[0]>) => Queue;
  job: (id: string) => OrchestratorJobRow;
  queuedJob: (change?: (worktree: string) => void) => Promise<string>;
  originMain: () => string;
};

/**
 * A workspace with an origin, its main checkout, an upstream clone, and a jobs
 * service whose withdrawal goes to a real merge queue's `cancel` — the same
 * wiring orchestrator.module.ts uses (before the queue exists it refuses).
 */
async function withWiredWorkspace(
  runTest: (ctx: Fixture) => Promise<void>,
  tune: (config: OrchestratorConfig, root: string) => void = () => undefined,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'queued-cancel-refute-'));
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
  commitFile(repo, 'base.txt', 'one\ntwo\nthree\n', 'start');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // Someone else pushing to main meanwhile.
  git(root, 'clone', '-q', origin, upstream);

  const config = loadOrchestratorConfig(path.join(root, 'none.json'));
  config.workspacesRoot = workspaces;
  config.worktreesRoot = path.join(workspaces, '.jobs');
  config.checks = { demo: 'true' };
  config.forgejo.tokenFile = path.join(root, 'no-token');
  config.glmPeakHours.avoid = false;
  config.review.enabled = false; // the review gate has its own adversarial suite
  tune(config, root);

  const runtime = createRuntime();
  const outbox = createEffectOutbox({});
  const admitAllMorph = {
    usage: () => computeMorphUsage([], config.morph.caps, new Date(), 'none'),
    admitted: () => true,
  };
  const createJobs = (overrides: Partial<Parameters<typeof createJobsService>[0]> = {}) => createJobsService({
    runtime: runtime.gateway,
    config: () => config,
    probeZcode: async () => ({ ok: true }),
    morphUsage: admitAllMorph,
    outbox,
    ...overrides,
  });
  const createQueue = (overrides: Partial<Parameters<typeof createMergeQueueService>[0]> = {}) => createMergeQueueService({
    jobs: jobs,
    config: () => config,
    outbox,
    ...overrides,
  });
  const queueRef: { current: Queue | null } = { current: null };
  const jobs = createJobs({
    // The module's wiring: the service hands a queue-step job to the real queue's cancel.
    withdrawFromMergeQueue: (job) => queueRef.current ? queueRef.current.cancel(job) : Promise.resolve({ cancelled: false, reason: `Job ${job.id} is already in the CI/CD queue (${job.merge_step})` }),
  });
  const queue = createQueue();
  queueRef.current = queue;

  const queuedJob = async (change: (worktree: string) => void = (wt) => commitFile(wt, 'feature.txt', 'f\n', 'feature')) => {
    const created = await jobs.create({ title: 'change', prompt: 'p', repoPath: repo, backend: 'glm', baseBranch: null });
    await eventually(() => (orchestratorJobsDb.get(created.id) as OrchestratorJobRow).state === 'active', 'the job to start');
    change((orchestratorJobsDb.get(created.id) as OrchestratorJobRow).worktree_path);
    runtime.finish((orchestratorJobsDb.get(created.id) as OrchestratorJobRow).session_id!);
    await jobs.markDone(created.id); // review disabled: straight to the CI/CD queue
    return created.id;
  };

  try {
    await runTest({
      root, repo, upstream, origin, config, runtime, outbox, queue, jobs, createJobs, createQueue,
      job: (id) => orchestratorJobsDb.get(id) as OrchestratorJobRow,
      queuedJob,
      originMain: () => git(origin, 'rev-parse', 'main'),
    });
  } finally {
    // A probe that fails before its cancellation still owns its children: kill them by pid.
    for (const marker of ['check.pid', 'resolver.pid']) {
      try {
        const pid = Number(readFileSync(path.join(root, marker), 'utf8').trim());
        if (pid > 0) {
          try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        }
      } catch { /* the child never started */ }
    }
    chatRunRegistry.clearAll();
    await jobs.afterCheckpoints().catch(() => {});
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('wired tjob cancel withdraws a queued job through the real merge queue and frees the lane for its sibling', async () => {
  await withWiredWorkspace(async (ctx) => {
    const a = await ctx.queuedJob();
    const b = await ctx.queuedJob((wt) => commitFile(wt, 'sibling.txt', 's\n', 'sibling'));
    const before = ctx.originMain();
    const branchA = ctx.job(a).branch;
    const events: string[] = [];
    const off = onHubEvent((event) => { if (event.jobId === a) events.push(event.state); });

    assert.equal(ctx.job(a).merge_step, 'queued', 'no tick has run: the job sits unstarted in the queue');
    const view = await ctx.jobs.cancel(a);
    off();

    assert.equal(view.state, 'cancelled');
    assert.equal(view.merge_step, 'none');
    const row = ctx.job(a);
    assert.ok(readMergeStepHistory(row).some((event) => event.step === 'cancelled' && event.by === 'tjob cancel'),
      'the queue (not the fallback) recorded the withdrawal with its by-line');
    assert.deepEqual(events, ['cancelled'], 'the hub heard exactly the cancellation');
    assert.equal(ctx.originMain(), before, 'nothing reached origin');

    // The cancelled step is resting: the job view counts no running time for it.
    const timings = mergeStepTimings(readMergeStepHistory(row), Date.now());
    assert.equal(timings.find((t) => t.step === 'cancelled')?.durationMs, null);

    // The lane is free again: the sibling goes through the queue onto origin/main.
    for (let i = 0; i < 20 && ctx.job(b).merge_step !== 'merged'; i += 1) await ctx.queue.tick();
    assert.equal(ctx.job(b).merge_step, 'merged');
    git(ctx.upstream, 'fetch', '-q', 'origin', 'main');
    assert.equal(git(ctx.upstream, 'show', 'FETCH_HEAD:sibling.txt'), 's', 'the sibling landed');
    // The cancelled branch never became part of main.
    assert.notEqual(git(ctx.repo, 'rev-parse', branchA), ctx.originMain());
    git(ctx.repo, 'fetch', '-q', 'origin', 'main');
    assert.notEqual(gitCode(ctx.repo, 'merge-base', '--is-ancestor', branchA, 'origin/main'), 0, 'the cancelled commit is not on main');
  });
});

for (const step of ['push', 'deploy', 'merged'] as const) {
  test(`wired tjob cancel at ${step} is refused and leaves the job in the queue`, async () => {
    await withWiredWorkspace(async (ctx) => {
      const id = await ctx.queuedJob();
      for (let i = 0; i < 20 && ctx.job(id).merge_step !== step; i += 1) await ctx.queue.tick();
      assert.equal(ctx.job(id).merge_step, step);
      const historyBefore = readMergeStepHistory(ctx.job(id)).length;
      const branchTip = git(ctx.repo, 'rev-parse', ctx.job(id).branch);

      await assert.rejects(ctx.jobs.cancel(id), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'JOB_MERGING');
        assert.match((error as Error).message, /already pushing; it will merge/);
        return true;
      });

      const after = ctx.job(id);
      assert.equal(after.state, 'done');
      assert.equal(after.merge_step, step);
      assert.equal(readMergeStepHistory(after).length, historyBefore, 'no cancelled entry was appended');
      assert.equal(git(ctx.repo, 'rev-parse', ctx.job(id).branch), branchTip, 'the branch is untouched');
    });
  });
}

test('a jobs service without a wired queue cancels a queued job itself and still refuses from the push', async () => {
  await withWiredWorkspace(async (ctx) => {
    // The 127a8543 standalone path: no withdrawal callback at all.
    const standalone = ctx.createJobs({ withdrawFromMergeQueue: undefined });
    const id = await ctx.queuedJob();
    const cancelled = await standalone.cancel(id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.merge_step, 'none');
    assert.ok(readMergeStepHistory(ctx.job(id)).some((event) => event.step === 'cancelled' && event.by === 'tjob cancel'));

    const pushing = await ctx.queuedJob();
    for (let i = 0; i < 20 && ctx.job(pushing).merge_step !== 'push'; i += 1) await ctx.queue.tick();
    assert.equal(ctx.job(pushing).merge_step, 'push');
    await assert.rejects(standalone.cancel(pushing), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'JOB_MERGING');
      assert.match((error as Error).message, /already pushing; it will merge/);
      return true;
    });
    assert.equal(ctx.job(pushing).state, 'done', 'the refusal cancelled nothing');
  });
});

test('a queue refusal and a queue exception are not mistaken for a successful cancellation', async () => {
  await withWiredWorkspace(async (ctx) => {
    const refusing = ctx.createJobs({ withdrawFromMergeQueue: async () => ({ cancelled: false, reason: 'the queue says no' }) });
    const id = await ctx.queuedJob();
    await assert.rejects(refusing.cancel(id), /the queue says no/);
    let row = ctx.job(id);
    assert.equal(row.state, 'done');
    assert.equal(row.merge_step, 'queued');
    assert.ok(!readMergeStepHistory(row).some((event) => event.step === 'cancelled'), 'no cancellation evidence');

    const exploding = ctx.createJobs({ withdrawFromMergeQueue: async () => { throw new Error('the queue exploded'); } });
    const other = await ctx.queuedJob();
    await assert.rejects(exploding.cancel(other), /the queue exploded/, 'an exception propagates, it is not a success');
    row = ctx.job(other);
    assert.equal(row.state, 'done');
    assert.equal(row.merge_step, 'queued');
    assert.ok(!readMergeStepHistory(row).some((event) => event.step === 'cancelled'), 'no cancellation evidence');
  });
});

test('cancelling during a real running check kills the tracked process and never pushes', async () => {
  await withWiredWorkspace(async (ctx) => {
    const id = await ctx.queuedJob();
    await ctx.queue.tick(); // queued -> rebase
    assert.equal(ctx.job(id).merge_step, 'rebase');
    await ctx.queue.tick(); // rebase -> check
    assert.equal(ctx.job(id).merge_step, 'check');
    const ticking = ctx.queue.tick(); // runs the check: the child blocks for the probe
    let pid = 0;
    try {
      await eventually(() => {
        try {
          pid = Number(readFileSync(path.join(ctx.root, 'check.pid'), 'utf8').trim());
          return pid > 0;
        } catch {
          return false;
        }
      }, 'the check child to write its pid');
      await eventually(() => {
        try {
          return readFileSync(getCheckLogPath(ctx.job(id).worktree_path), 'utf8').includes('check started');
        } catch {
          return false;
        }
      }, 'the check to start');

      const view = await ctx.jobs.cancel(id);
      assert.equal(view.state, 'cancelled');
    } finally {
      await ticking.catch(() => {});
    }

    assert.throws(() => process.kill(pid, 0), 'the tracked child is gone (reaped, not a zombie)');
    assert.doesNotMatch(execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }), /tail -f \/dev\/null/,
      'no orphan of the fixture command survives');

    const row = ctx.job(id);
    assert.equal(row.state, 'cancelled');
    assert.equal(row.merge_step, 'none');
    assert.ok(readMergeStepHistory(row).some((event) => event.step === 'cancelled' && event.by === 'tjob cancel'));
    assert.ok(!readMergeStepHistory(row).some((event) => event.step === 'push'), 'no push was recorded');
    assert.ok(orchestratorEffectsDb.listByJob(id, 'merge_check').some((effect) => effect.last_error === 'cancelled'),
      'the check effect was finished as cancelled, not left running');

    const before = ctx.originMain();
    await ctx.queue.tick();
    await ctx.queue.tick();
    assert.equal(ctx.originMain(), before, 'nothing reached origin, ever');
    assert.equal(ctx.job(id).merge_step, 'none', 'the cancelled job does not come back');
  }, (config, root) => {
    // exec makes the tracked pid itself block; SIGTERM to the process group ends it.
    config.checks = { demo: `echo check started; echo $$ > ${root}/check.pid; exec tail -f /dev/null` };
  });
});

test('cancelling during a stopped rebase aborts the rebase and leaves the worktree clean', async () => {
  await withWiredWorkspace(async (ctx) => {
    // The job's branch commits first; then the base moves with a conflicting change,
    // so the queue's rebase (onto the freshly fetched origin/main) stops mid-way.
    const id = await ctx.queuedJob((wt) => commitFile(wt, 'base.txt', 'job-side\n', 'job side'));
    const branchTip = git(ctx.repo, 'rev-parse', ctx.job(id).branch);
    commitFile(ctx.upstream, 'base.txt', 'main-moved\n', 'main moved first');
    git(ctx.upstream, 'push', '-q', 'origin', 'HEAD:main');
    const movedMain = ctx.originMain();
    // The conflict resolver is a fixture script that blocks until the probe cancels it.
    const resolver = path.join(ctx.root, 'resolver.sh');
    writeFileSync(resolver, `#!/bin/sh\nprintf '%s\\n' "$$" > ${ctx.root}/resolver.pid\nexec tail -f /dev/null\n`);
    chmodSync(resolver, 0o755);
    ctx.config.conflictResolver = { command: resolver, model: 'fixture' };

    await ctx.queue.tick(); // queued -> rebase
    assert.equal(ctx.job(id).merge_step, 'rebase');
    const ticking = ctx.queue.tick(); // the rebase stops on the conflict; the resolver blocks
    const worktree = ctx.job(id).worktree_path;
    let pid = 0;
    try {
      await eventually(() => {
        try {
          pid = Number(readFileSync(path.join(ctx.root, 'resolver.pid'), 'utf8').trim());
          return pid > 0;
        } catch {
          return false;
        }
      }, 'the blocked resolver to start');
      assert.ok(git(worktree, 'status', '--porcelain').length > 0, 'the rebase stopped mid-way with conflicts');

      const result = await ctx.queue.cancel(ctx.job(id));
      assert.equal(result.cancelled, true);
    } finally {
      await ticking.catch(() => {});
    }

    assert.throws(() => process.kill(pid, 0), 'the tracked resolver is gone');
    assert.equal(git(worktree, 'status', '--porcelain'), '', 'the worktree is clean after the abort');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), branchTip, 'the branch tip is untouched');
    const inProgress = ['rebase-merge', 'rebase-apply'].some((dir) =>
      existsSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', dir))));
    assert.equal(inProgress, false, 'no rebase is left in progress');
    const row = ctx.job(id);
    assert.equal(row.state, 'cancelled');
    assert.equal(row.merge_step, 'none');
    assert.equal(ctx.originMain(), movedMain, 'origin only has the base move, not the job');

    await ctx.queue.tick();
    await ctx.queue.tick();
    assert.equal(ctx.job(id).merge_step, 'none', 'the cancelled job does not come back');
  });
});

test('a check that finishes after its cancellation cannot set the push (token barrier)', async () => {
  await withWiredWorkspace(async (ctx) => {
    const id = await ctx.queuedJob();
    let release!: (result: CommandResult) => void;
    const held = new Promise<CommandResult>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedOnce = new Promise<void>((resolve) => { started = resolve; });
    const run: typeof runCommand = (command, args, options) => {
      if (command === 'nice') {
        started();
        return held; // the check runs forever, until the probe releases it
      }
      return runCommand(command, args, options);
    };
    const queue = ctx.createQueue({ run });
    const jobs = ctx.createJobs({ withdrawFromMergeQueue: (job) => queue.cancel(job) });

    await queue.tick(); // queued -> rebase
    await queue.tick(); // rebase -> check
    assert.equal(ctx.job(id).merge_step, 'check');
    const ticking = queue.tick(); // runs the check: it is held
    try {
      await startedOnce;

      const withdrawn = await jobs.cancel(id);
      assert.equal(withdrawn.state, 'cancelled');
    } finally {
      release({ code: 0, stdout: '', stderr: '' }); // the check "passes" after the cancellation
      await ticking.catch(() => {});
    }

    const row = ctx.job(id);
    assert.equal(row.state, 'cancelled');
    assert.equal(row.merge_step, 'none', 'a finished check must not move a cancelled job on');
    assert.ok(!readMergeStepHistory(row).some((event) => event.step === 'push'), 'no push was recorded');
    const before = ctx.originMain();
    await queue.tick();
    await queue.tick();
    assert.equal(ctx.originMain(), before, 'nothing reached origin');
  });
});

test('a rebase that finishes after its cancellation cannot reach the check (token barrier)', async () => {
  await withWiredWorkspace(async (ctx) => {
    const id = await ctx.queuedJob();
    let release!: (result: CommandResult) => void;
    const held = new Promise<CommandResult>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedOnce = new Promise<void>((resolve) => { started = resolve; });
    const run: typeof runCommand = (command, args, options) => {
      if (command === 'git' && args[0] === 'rebase' && args[1] === 'origin/main') {
        started();
        return held; // the rebase runs forever, until the probe releases it
      }
      return runCommand(command, args, options);
    };
    const queue = ctx.createQueue({ run });
    const jobs = ctx.createJobs({ withdrawFromMergeQueue: (job) => queue.cancel(job) });

    await queue.tick(); // queued -> rebase (the step is set, not run)
    assert.equal(ctx.job(id).merge_step, 'rebase');
    const ticking = queue.tick(); // runs the rebase: it is held
    try {
      await startedOnce;

      const withdrawn = await jobs.cancel(id);
      assert.equal(withdrawn.state, 'cancelled');
    } finally {
      release({ code: 0, stdout: '', stderr: '' }); // the rebase "succeeds" after the cancellation
      await ticking.catch(() => {});
    }

    const row = ctx.job(id);
    assert.equal(row.state, 'cancelled');
    assert.equal(row.merge_step, 'none', 'a finished rebase must not move a cancelled job on');
    assert.equal(readMergeStepHistory(row).at(-1)?.step, 'cancelled', 'the cancelled entry is the last one');
    // The post-cancel sweep may already have disposed of the clean worktree; either way
    // no half-finished rebase state may survive in it.
    const worktree = ctx.job(id).worktree_path;
    if (existsSync(worktree)) {
      const inProgress = ['rebase-merge', 'rebase-apply'].some((dir) =>
        existsSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', dir))));
      assert.equal(inProgress, false, 'no rebase is left in progress');
    } else {
      assert.ok(true, 'the clean worktree was disposed whole: no rebase state survived');
    }
    const before = ctx.originMain();
    await queue.tick();
    await queue.tick();
    assert.equal(ctx.originMain(), before, 'nothing reached origin');
  });
});

test('a duplicate cancel, a late approve and a post-restart push replay stay inert for a cancelled job', async () => {
  await withWiredWorkspace(async (ctx) => {
    const id = await ctx.queuedJob();
    const before = ctx.originMain();
    const events: string[] = [];
    const off = onHubEvent((event) => { if (event.jobId === id) events.push(event.state); });

    await ctx.jobs.cancel(id);
    const again = await ctx.jobs.cancel(id); // the second pass finds no queue step left
    off();
    assert.equal(again.state, 'cancelled');
    assert.equal(readMergeStepHistory(ctx.job(id)).filter((event) => event.step === 'cancelled').length, 1,
      'exactly one cancelled history entry');
    assert.equal(events.filter((state) => state === 'cancelled').length, 1, 'exactly one cancelled hub event');

    // The real queue, asked about the now-cancelled job, refuses instead of re-cancelling.
    const refused = await ctx.queue.cancel(ctx.job(id));
    assert.equal(refused.cancelled, false);
    assert.match(refused.reason ?? '', /not in the CI\/CD queue/);
    assert.equal(readMergeStepHistory(ctx.job(id)).filter((event) => event.step === 'cancelled').length, 1);

    await assert.rejects(ctx.jobs.approve(id), /not waiting for review/, 'a cancelled job is not approvable');

    // Shutdown semantics: a restart replaying the queue's push handler skips a cancelled job.
    await ctx.queue.effectHandlers().push({ job_id: id } as OrchestratorEffectRow, {});
    assert.equal(ctx.originMain(), before, 'the replay pushed nothing');
    assert.equal(ctx.job(id).state, 'cancelled');
    assert.equal(ctx.job(id).merge_step, 'none');
  });
});

test('a failed cleanup keeps the job cancelled and the next sweep finishes the disposal', async () => {
  await withWiredWorkspace(async (ctx) => {
    const id = await ctx.queuedJob();
    const worktree = ctx.job(id).worktree_path;
    writeFileSync(path.join(worktree, 'leftover.txt'), 'untracked\n'); // dirty: the disposal must keep it
    const view = await ctx.jobs.cancel(id);
    assert.equal(view.state, 'cancelled');
    assert.equal(view.merge_step, 'none');
    assert.ok(existsSync(worktree), 'a dirty worktree is kept, not half-removed');
    await assert.rejects(ctx.jobs.approve(id), /not waiting for review/, 'the kept job is still not approvable');
    assert.equal(ctx.job(id).state, 'cancelled', 'a failed disposal does not resurrect the job');
    assert.equal(ctx.job(id).merge_step, 'none');

    // Once the dirt is gone the same sweep finishes the disposal; the branch is kept.
    rmSync(path.join(worktree, 'leftover.txt'));
    const results = await ctx.jobs.sweepCleanup();
    assert.ok(results.some((result) => result.id === id && result.status === 'cleaned'), JSON.stringify(results));
    assert.ok(!existsSync(worktree), 'the worktree is gone after the successful sweep');
    git(ctx.repo, 'rev-parse', '--verify', ctx.job(id).branch);
    assert.equal(ctx.job(id).state, 'cancelled');
    assert.equal(ctx.job(id).merge_step, 'none');
  });
});

test('the hub wake reads a cancelled event as cancelled', () => {
  assert.equal(
    formatHubEventStateDescription({ jobId: 'x', state: 'cancelled', title: 't', reason: 'left the queue', timestamp: 'now' }),
    'cancelled, left the queue',
  );
});
