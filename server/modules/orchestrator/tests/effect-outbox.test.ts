import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorEffectsDb, orchestratorJobsDb, userDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { createEffectOutbox, SimulatedCrash } from '../services/effect-outbox.service.js';
import type { EffectBoundary, EffectOutbox } from '../services/effect-outbox.service.js';
import { createJobsService } from '../services/jobs.service.js';
import { createMergeQueueService } from '../services/merge-queue.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import { runCommand } from '../services/workspace.service.js';

const BOUNDARIES: EffectBoundary[] = ['before_write', 'after_write', 'during_run', 'after_run'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A crash at one boundary of the effects whose key starts with `prefix`; `onCrash` marks the process dead. */
function crashAt(boundary: EffectBoundary, prefix: string, onCrash: () => void = () => undefined) {
  let fired = false;
  return (at: EffectBoundary, key: string) => {
    if (fired || at !== boundary || !key.startsWith(prefix)) return;
    fired = true;
    onCrash();
    throw new SimulatedCrash(at);
  };
}

function createRuntime() {
  const turns: Array<{ sessionId: string; command: string }> = [];
  const open = new Map<string, () => void>();
  return {
    turns,
    finish(sessionId: string) {
      chatRunRegistry.completeRun(sessionId, { exitCode: 0 });
      open.get(sessionId)?.();
    },
    gateway: {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
      abort: async (_provider: string, sessionId: string) => { open.get(sessionId)?.(); open.delete(sessionId); return true; },
      run: (_provider: string, command: string, options: Record<string, unknown>) => {
        const sessionId = String(options.sessionId);
        turns.push({ sessionId, command });
        return new Promise<void>((resolve) => open.set(sessionId, resolve));
      },
    },
  };
}

type Ctx = {
  root: string;
  repo: string;
  config: OrchestratorConfig;
  runtime: ReturnType<typeof createRuntime>;
  job: (id: string) => OrchestratorJobRow;
  /** A server process: its own outbox (boot id), jobs service and queue. The previous one stops listening. */
  boot: (boundary?: (at: EffectBoundary, key: string) => void, run?: typeof runCommand) => Proc;
};
type Proc = { outbox: EffectOutbox; jobs: ReturnType<typeof createJobsService>; queue: ReturnType<typeof createMergeQueueService> };

async function withWorkspace(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'outbox-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  userDb.createUser('orchestrator', 'hash');
  const origin = path.join(root, 'origin.git');
  const workspaces = path.join(root, 'ws');
  const repo = path.join(workspaces, 'demo');
  await mkdir(workspaces, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  commitFile(repo, 'app.txt', 'one\n', 'start');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');

  const config = loadOrchestratorConfig(path.join(root, 'none.json'));
  config.workspacesRoot = workspaces;
  config.worktreesRoot = path.join(workspaces, '.jobs');
  config.checks = { demo: 'true' };
  config.forgejo.tokenFile = path.join(root, 'no-token');
  config.glmPeakHours.avoid = false;
  config.review.enabled = false;
  const runtime = createRuntime();
  let unsubscribe = null as (() => void) | null;
  const boot: Ctx['boot'] = (boundary, run) => {
    unsubscribe?.();
    const outbox = createEffectOutbox({ boundary });
    const jobs = createJobsService({ runtime: runtime.gateway, config: () => config, outbox, probeZcode: async () => ({ ok: true }) });
    const queue = createMergeQueueService({ jobs, config: () => config, outbox, ...(run ? { run } : {}) });
    unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
    return { outbox, jobs, queue };
  };
  try {
    await runTest({ root, repo, config, runtime, boot, job: (id) => orchestratorJobsDb.get(id) as OrchestratorJobRow });
  } finally {
    unsubscribe?.();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

/** Startup as orchestrator.module.ts runs it: outbox recovery (replay, adopt, drop), then the jobs' own. */
async function restart(proc: Proc): Promise<void> {
  await proc.outbox.recover({ ...proc.jobs.effectHandlers(), ...proc.queue.effectHandlers() }, (row) => proc.jobs.adoptEffect(row));
  await proc.jobs.recover();
}

const continues = (ctx: Ctx) => ctx.runtime.turns.filter((turn) => /restarted/.test(turn.command)).length;

for (const boundary of BOUNDARIES) {
  test(`outbox: a crash ${boundary} replays a safe effect once and never replays a process-bound one`, async () => {
    await withWorkspace(async () => {
      const applied = new Set<string>();
      let effectRuns = 0;
      let replays = 0;
      // An idempotent effect: applying it twice changes nothing; the count shows how often it actually ran.
      const apply = async (key: string) => { effectRuns += 1; await Promise.resolve(); applied.add(key); };
      for (const replay of ['safe', 'process_bound'] as const) {
        const key = `push:job-${replay}`;
        const before = createEffectOutbox({ boundary: crashAt(boundary, key) });
        await assert.rejects(before.run({ key, jobId: `job-${replay}`, kind: 'push', replay }, () => apply(key)), SimulatedCrash);
        const row = orchestratorEffectsDb.get(key);
        assert.equal(row === null, boundary === 'before_write', `${replay}: row written before the effect`);

        const after = createEffectOutbox();
        const report = await after.recover({ push: async (replayed) => { replays += 1; await apply(replayed.key); } });
        const now = orchestratorEffectsDb.get(key);
        if (boundary === 'before_write') {
          assert.equal(now, null);
        } else if (replay === 'safe') {
          assert.deepEqual(report.replayed, [key]);
          assert.equal(now?.state, 'done');
          // Asked again after the restart (the state machine's own resume): idempotent by key, it does not run.
          const again = await after.run({ key, jobId: `job-${replay}`, kind: 'push', replay }, () => apply(key));
          assert.equal(again.status, 'skipped');
        } else {
          assert.deepEqual(report.dropped, [key]);
          assert.equal(now?.state, 'dropped');
          assert.match(now?.last_error ?? '', /bound to the previous server process/);
        }
      }
      const expectedReplays = boundary === 'before_write' ? 0 : 1;
      assert.equal(replays, expectedReplays, 'only the safe effect is replayed');
      // The safe effect ran at most once before and once on replay; the process-bound one never after the restart.
      const startedBefore = boundary === 'during_run' || boundary === 'after_run' ? 2 : 0;
      assert.equal(effectRuns, startedBefore + expectedReplays);
    });
  });

  test(`no duplicate turn: the restart continue is cut ${boundary}, and the next start sends at most one`, async () => {
    for (const survived of boundary === 'during_run' || boundary === 'after_run' ? [false, true] : [false]) {
      await withWorkspace(async (ctx) => {
        const first = ctx.boot();
        const created = await first.jobs.create({ title: 'long', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
        await eventually(() => ctx.job(created.id).state === 'active' && ctx.runtime.turns.length === 1, 'first turn');

        // Restart 1: the turn died with the server; this start crashes while sending the continue.
        chatRunRegistry.clearAll();
        const second = ctx.boot(crashAt(boundary, 'resume:'));
        await assert.rejects(restart(second), SimulatedCrash);
        // The cut continue's turn had started (during/after run): it reaches the provider.
        if (boundary === 'during_run' || boundary === 'after_run') await eventually(() => continues(ctx) === 1, 'the cut continue turn');
        const sentBySecond = continues(ctx);
        assert.equal(sentBySecond, boundary === 'during_run' || boundary === 'after_run' ? 1 : 0);

        // Restart 2: the continue's turn died too, or (survived) its detached unit re-attached.
        if (!survived) chatRunRegistry.clearAll();
        const third = ctx.boot();
        await restart(third);
        // Hub resume, re-attach and the balancer's tick all asking again changes nothing.
        await third.jobs.recover();
        await restart(third);
        await third.jobs.tick();
        const sentByThird = continues(ctx) - sentBySecond;
        assert.equal(sentByThird, survived ? 0 : 1, `survived=${survived}`);
        // Never two live turns: at most one start_turn is open, and each cut turn got exactly one continue.
        const open = orchestratorEffectsDb.listByJob(created.id, 'start_turn').filter((row) => row.state === 'running');
        assert.equal(open.length, 1);
        const resumes = orchestratorEffectsDb.listByJob(created.id, 'recovery_resume');
        assert.ok(resumes.every((row) => row.state === 'done'), JSON.stringify(resumes.map((row) => [row.key, row.state])));
      });
    }
  });

  test(`no lost or doubled push: the push is cut ${boundary}`, async () => {
    await withWorkspace(async (ctx) => {
      let pushes = 0;
      let dead = false;
      const counting = (gone: () => boolean): typeof runCommand => (command, args, options) => {
        if (gone()) return Promise.reject(new Error('the process is gone'));
        if (command === 'git' && args[0] === 'push') pushes += 1;
        return runCommand(command, args, options);
      };
      const first = ctx.boot(crashAt(boundary, 'push:', () => { dead = true; }), counting(() => dead));
      const id = await finished(ctx, first);
      for (let i = 0; i < 20 && ctx.job(id).merge_step !== 'push'; i += 1) await first.queue.tick();
      assert.equal(ctx.job(id).merge_step, 'push');
      await first.queue.tick(); // the push step crashes at the boundary
      assert.ok(dead);

      const second = ctx.boot(undefined, counting(() => false));
      await restart(second);
      for (let i = 0; i < 10 && ctx.job(id).merge_step === 'push'; i += 1) await second.queue.tick();
      const head = git(ctx.job(id).worktree_path, 'rev-parse', 'HEAD');
      assert.ok(['deploy', 'merged'].includes(ctx.job(id).merge_step), ctx.job(id).merge_step);
      assert.equal(ctx.job(id).pushed_sha, head);
      assert.equal(git(ctx.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head);
      assert.equal(pushes, 1, 'pushed exactly once');
    });
  });
}

/** A job whose agent committed a change and ran `tjob done`. */
async function finished(ctx: Ctx, proc: Proc): Promise<string> {
  const created = await proc.jobs.create({ title: 'change', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
  await eventually(() => ctx.job(created.id).state === 'active', 'start');
  commitFile(ctx.job(created.id).worktree_path, 'feature.txt', 'f\n', 'feature');
  ctx.runtime.finish(ctx.job(created.id).session_id!);
  await proc.jobs.markDone(created.id);
  return created.id;
}

test('no lost push: the process dies right after git push, before recording it', async () => {
  await withWorkspace(async (ctx) => {
    let pushes = 0;
    let dead = false;
    const first = ctx.boot(undefined, async (command, args, options) => {
      if (dead) throw new Error('the process is gone');
      const result = await runCommand(command, args, options);
      if (command === 'git' && args[0] === 'push') {
        pushes += 1;
        dead = true;
        throw new SimulatedCrash('during_run');
      }
      return result;
    });
    const id = await finished(ctx, first);
    for (let i = 0; i < 20 && !dead; i += 1) await first.queue.tick();
    assert.equal(ctx.job(id).merge_step, 'push', 'the push reached origin but was not recorded');
    assert.equal(orchestratorEffectsDb.listByJob(id, 'push')[0]?.state, 'running');

    const second = ctx.boot(undefined, async (command, args, options) => {
      if (command === 'git' && args[0] === 'push') pushes += 1;
      return runCommand(command, args, options);
    });
    await restart(second);
    assert.ok(['deploy', 'merged'].includes(ctx.job(id).merge_step));
    assert.equal(pushes, 1);
    assert.equal(orchestratorEffectsDb.listByJob(id, 'push')[0]?.state, 'done');
  });
});

test('a merge state recorded without the push on origin goes back to push and pushes', async () => {
  await withWorkspace(async (ctx) => {
    const first = ctx.boot();
    const id = await finished(ctx, first);
    for (let i = 0; i < 20 && ctx.job(id).merge_step !== 'push'; i += 1) await first.queue.tick();
    const head = git(ctx.job(id).worktree_path, 'rev-parse', 'HEAD');
    // What we hit on 2026-11-06: deploy recorded, push row still open, main without the commit.
    first.outbox.begin({ key: `push:${id}:${head}:x`, jobId: id, kind: 'push', replay: 'safe' });
    orchestratorJobsDb.update(id, { merge_step: 'deploy', pushed_sha: head });

    const second = ctx.boot();
    await restart(second);
    assert.equal(git(ctx.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head);
    assert.ok(['deploy', 'merged'].includes(ctx.job(id).merge_step));
    assert.equal(ctx.job(id).pushed_sha, head);
  });
});

test('a merge check cut by a restart is dropped and run again; one that passed is not run again', async () => {
  await withWorkspace(async (ctx) => {
    let dead = false;
    const gone: typeof runCommand = (command, args, options) => (dead ? Promise.reject(new Error('the process is gone')) : runCommand(command, args, options));
    const first = ctx.boot(undefined, gone);
    // The check is not run through outbox.run: crash it right after its row is running.
    const original = first.outbox.begin;
    first.outbox.begin = (spec) => {
      const begun = original(spec);
      if (spec.kind === 'merge_check' && begun.status === 'begun') { dead = true; throw new SimulatedCrash('during_run'); }
      return begun;
    };
    const id = await finished(ctx, first);
    for (let i = 0; i < 20 && !dead; i += 1) await first.queue.tick();
    assert.equal(ctx.job(id).merge_step, 'check');

    const second = ctx.boot();
    await restart(second);
    const [dropped] = orchestratorEffectsDb.listByJob(id, 'merge_check');
    assert.equal(dropped?.state, 'dropped');
    for (let i = 0; i < 10 && ctx.job(id).merge_step === 'check'; i += 1) await second.queue.tick();
    assert.notEqual(ctx.job(id).merge_step, 'check');
    const checks = orchestratorEffectsDb.listByJob(id, 'merge_check');
    assert.equal(checks.length, 1, 'same step entry, same key: run again as attempt 2');
    assert.equal(checks[0]?.attempts, 2);
    assert.equal(checks[0]?.state, 'done');
  });
});

for (const boundary of ['after_write', 'after_run'] as const) {
  test(`no lost cleanup: a worktree cleanup cut ${boundary} is finished after the restart`, async () => {
    await withWorkspace(async (ctx) => {
      const first = ctx.boot(crashAt(boundary, 'cleanup:'));
      const created = await first.jobs.create({ title: 'drop', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
      await eventually(() => ctx.job(created.id).state === 'active', 'start');
      await first.jobs.cancel(created.id).catch(() => undefined); // its tick runs the crashing sweep
      await first.jobs.sweepCleanup(false, true).catch(() => undefined);
      const [row] = orchestratorEffectsDb.listByJob(created.id, 'cleanup');
      assert.equal(row?.state, boundary === 'after_write' ? 'pending' : 'running');

      const second = ctx.boot();
      await restart(second);
      assert.equal(existsSync(ctx.job(created.id).worktree_path), false);
      assert.equal(orchestratorEffectsDb.get(row!.key)?.state, 'done');
      // The automatic sweep after the restart finds it done.
      await second.jobs.sweepCleanup(false, true);
      assert.equal(orchestratorEffectsDb.listByJob(created.id, 'cleanup').length, 1);
    });
  });
}

test('a failing cleanup blocks the job: no new turn before the old work is undone', async () => {
  await withWorkspace(async (ctx) => {
    const first = ctx.boot();
    const created = await first.jobs.create({ title: 'stuck', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
    await eventually(() => ctx.job(created.id).state === 'active', 'start');
    const worktree = ctx.job(created.id).worktree_path;
    git(ctx.repo, 'worktree', 'lock', worktree); // `git worktree remove --force` refuses a locked worktree
    await first.jobs.cancel(created.id);
    await first.jobs.sweepCleanup(false, true);
    const [row] = orchestratorEffectsDb.listByJob(created.id, 'cleanup');
    assert.equal(row?.state, 'failed');
    assert.equal(row?.blocking, 1);
    const turns = ctx.runtime.turns.length;

    assert.equal(await first.jobs.notify(ctx.job(created.id), 'more work'), false);
    await assert.rejects(first.jobs.resume(created.id), /cannot resume/);
    // A restart retries the undo; it still fails, so it still blocks.
    const second = ctx.boot();
    await restart(second);
    await assert.rejects(second.jobs.resume(created.id), /cannot resume/);
    assert.equal(ctx.runtime.turns.length, turns, 'no turn while the cleanup is failed');
    // Another job is not blocked by it.
    const other = await second.jobs.create({ title: 'other', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
    await eventually(() => ctx.runtime.turns.length === turns + 1 && ctx.job(other.id).state === 'active', 'other job turn');

    git(ctx.repo, 'worktree', 'unlock', worktree);
    await second.jobs.resume(created.id);
    assert.equal(orchestratorEffectsDb.get(row!.key)?.state, 'done');
    await eventually(() => ctx.runtime.turns.length === turns + 2 && ctx.job(created.id).state === 'active', 'the resumed job\'s turn');
  });
});

for (const kind of ['push', 'recovery_resume'] as const) {
  test(`startup replay keeps the job's barrier: a ${kind} cut by a restart waits while the job's cleanup still fails`, async () => {
    await withWorkspace(async () => {
      // Regression (refute 2026-11-07): recover() retried the failed cleanup, then replayed the push anyway.
      const old = createEffectOutbox({ bootId: 'old' });
      old.begin({ key: kind, jobId: 'a', kind, replay: 'safe' });
      await assert.rejects(old.run({ key: 'cleanup', jobId: 'a', kind: 'cleanup', replay: 'safe', blocking: true }, async () => { throw new Error('cleanup failed'); }));
      // An unrelated job's same effect is not held.
      old.begin({ key: `${kind}-b`, jobId: 'b', kind, replay: 'safe' });

      let runs = 0;
      let cleanupFails = true;
      const handlers = {
        cleanup: async () => { if (cleanupFails) throw new Error('still failed'); },
        [kind]: async () => { runs += 1; },
      };
      const second = createEffectOutbox({ bootId: 'new' });
      const report = await second.recover(handlers);
      assert.deepEqual(report.failed, ['cleanup']);
      assert.deepEqual(report.held, [kind]);
      assert.deepEqual(report.replayed, [`${kind}-b`]);
      assert.equal(runs, 1, 'only the other job ran');
      assert.equal(orchestratorEffectsDb.get(kind)?.state, 'pending');
      assert.match(orchestratorEffectsDb.get(kind)?.last_error ?? '', /held: undo cleanup/);
      // The live path is held too: the same effect asked for again by the state machine is blocked.
      const live = await second.run({ key: kind, jobId: 'a', kind, replay: 'safe' }, async () => { runs += 1; });
      assert.equal(live.status === 'skipped' && live.reason, 'blocked');
      assert.equal(runs, 1);

      // Once the cleanup succeeds (next start), the held effect runs exactly once.
      cleanupFails = false;
      const third = createEffectOutbox({ bootId: 'third' });
      const after = await third.recover(handlers);
      assert.deepEqual(after.replayed, ['cleanup', kind]);
      assert.equal(runs, 2);
      assert.equal(orchestratorEffectsDb.get(kind)?.state, 'done');
      assert.deepEqual((await createEffectOutbox({ bootId: 'fourth' }).recover(handlers)).replayed, []);
      assert.equal(runs, 2);
    });
  });
}

test('usage-limit resume cut after its outbox row is delivered once, by the replay', async () => {
  await withWorkspace(async (ctx) => {
    const first = ctx.boot();
    const created = await first.jobs.create({ title: 'limited', prompt: 'p', repoPath: ctx.repo, backend: 'glm', baseBranch: null });
    await eventually(() => ctx.job(created.id).state === 'active' && ctx.runtime.turns.length === 1, 'start');
    ctx.runtime.finish(ctx.job(created.id).session_id!);
    const past = new Date(Date.now() - 60_000).toISOString();
    orchestratorJobsDb.update(created.id, {
      in_turn: 0,
      failure_class: 'usage_limit',
      limit_recovery: JSON.stringify({ key: 'k1', kind: 'usage_limit', resetAt: past, dueAt: past, attempt: 0, firstFailedAt: past, delivered: false, gaveUp: false, reason: 'limit' }),
    });

    const second = ctx.boot(crashAt('after_write', 'resume:limit:'));
    await assert.rejects(second.jobs.tick(), SimulatedCrash);
    const third = ctx.boot();
    await restart(third);
    await third.jobs.tick();
    await third.jobs.tick();
    const resumed = ctx.runtime.turns.filter((turn) => turn.command === 'Continue where you left off.');
    assert.equal(resumed.length, 1);
    assert.equal(continues(ctx), 0, 'no restart continue on top of the limit resume');
  });
});
