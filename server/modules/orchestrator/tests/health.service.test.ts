import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appConfigDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  orchestratorJobsDb,
  readTitleHistory,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { createHealthService, NO_COMMIT_NUDGE } from '../services/health.service.js';
import type { HealthDependencies, WorktreeHead } from '../services/health.service.js';
import { parseHubEventLine } from '../services/hub-wake.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';

type Sent = { jobId: string; message: string };

async function withHealthContext(
  fn: (ctx: {
    dir: string;
    eventsLogPath: string;
    config: OrchestratorConfig;
    clock: { now: Date; advance: (min: number) => void };
    heads: Map<string, WorktreeHead>;
    sent: Sent[];
    createJob: (id: string, overrides?: Partial<OrchestratorJobRow>) => OrchestratorJobRow;
    events: () => ReturnType<typeof parseHubEventLine>[];
  }) => Promise<void>,
) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousEventsLog = process.env.CLI_HUB_EVENTS_LOG;
  const dir = await mkdtemp(path.join(tmpdir(), 'health-test-'));
  const eventsLogPath = path.join(dir, 'hub-events.log');

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  process.env.CLI_HUB_EVENTS_LOG = eventsLogPath;
  await initializeDatabase();
  userDb.createUser('testuser', 'hash');

  const config = loadOrchestratorConfig(path.join(dir, 'none.json'));
  config.health = { enabled: true, noCommitMin: 45, maxRunMin: 30, deadSlotMin: 20 };
  const clock = {
    now: new Date('2026-11-10T12:00:00.000Z'),
    advance: (min: number) => {
      clock.now = new Date(clock.now.getTime() + min * 60_000);
    },
  };
  const heads = new Map<string, WorktreeHead>();
  const sent: Sent[] = [];

  const createJob = (id: string, overrides: Partial<OrchestratorJobRow> = {}): OrchestratorJobRow => {
    const job = orchestratorJobsDb.create({
      id,
      title: overrides.title ?? `Job ${id}`,
      prompt: 'work',
      repoPath: dir,
      baseBranch: 'main',
      branch: `feature/${id}`,
      worktreePath: path.join(dir, id),
      requestedBackend: 'claude',
    });
    const patch = { ...overrides } as Record<string, unknown>;
    delete patch.created_at;
    delete patch.updated_at;
    if (Object.keys(patch).length > 0) orchestratorJobsDb.update(id, patch as Partial<OrchestratorJobRow>);
    const created = overrides.created_at ?? clock.now.toISOString();
    const updated = overrides.updated_at ?? clock.now.toISOString();
    getConnection().prepare('UPDATE orchestrator_jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(created, updated, id);
    return orchestratorJobsDb.get(id) as OrchestratorJobRow;
  };

  const events = () => {
    if (!existsSync(eventsLogPath)) return [];
    return readFileSync(eventsLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map(parseHubEventLine)
      .filter((event): event is NonNullable<ReturnType<typeof parseHubEventLine>> => event !== null);
  };

  try {
    await fn({ dir, eventsLogPath, config, clock, heads, sent, createJob, events });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousEventsLog === undefined) delete process.env.CLI_HUB_EVENTS_LOG;
    else process.env.CLI_HUB_EVENTS_LOG = previousEventsLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

function serviceFor(ctx: {
  config: OrchestratorConfig;
  clock: { now: Date };
  heads: Map<string, WorktreeHead>;
  sent: Sent[];
}, overrides: Partial<HealthDependencies> = {}) {
  return createHealthService({
    config: () => ctx.config,
    now: () => ctx.clock.now,
    readHead: async (worktreePath) => ctx.heads.get(path.basename(worktreePath)) ?? null,
    sendToJob: async (job, message) => {
      ctx.sent.push({ jobId: job.id, message });
      return true;
    },
    ...overrides,
  });
}

function armedRecovery(ctx: { clock: { now: Date } }, gaveUp = false): string {
  return JSON.stringify({
    key: 'recovery-key',
    kind: 'usage_limit',
    resetAt: new Date(ctx.clock.now.getTime() + 2 * 60 * 60_000).toISOString(),
    dueAt: new Date(ctx.clock.now.getTime() + 2 * 60 * 60_000).toISOString(),
    attempt: 1,
    firstFailedAt: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    delivered: false,
    gaveUp,
    reason: 'usage cap reached; the provider stated a reset',
  });
}

async function realJobsService(ctx: { config: OrchestratorConfig; clock: { now: Date } }) {
  const { createJobsService } = await import('../services/jobs.service.js');
  return createJobsService({
    runtime: {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
      abort: async () => true,
      run: async () => undefined,
    },
    config: () => ctx.config,
    probeZcode: async () => ({ ok: true }),
    morphUsage: {
      usage: () => ({
        source: 'none', at: ctx.clock.now.toISOString(),
        groups: {
          kimi: { group: 'kimi', uncachedIn: 0, out: 0, caps: { uncachedIn: 1, out: 1 }, minutes: [] },
          deepseek: { group: 'deepseek', uncachedIn: 0, out: 0, caps: { uncachedIn: 1, out: 1 }, minutes: [] },
        },
      }),
      admitted: () => true,
    },
  });
}

function startBusy(sessionId: string): void {
  chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: `provider-${sessionId}`,
    connection: null,
    userId: null,
  });
}

test('no commit: nudges the job session first, then emits one hub event 15 min later', async () => {
  await withHealthContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const job = ctx.createJob('no-commit', {
      state: 'active',
      in_turn: 1,
      session_id: 'session-no-commit',
      created_at: new Date(ctx.clock.now.getTime() - 60 * 60_000).toISOString(),
    });
    startBusy(job.session_id!);
    ctx.heads.set('no-commit', { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });
    const service = serviceFor(ctx);

    await service.tick();
    assert.equal(ctx.sent.length, 1, 'the job session is nudged');
    assert.equal(ctx.sent[0].message, NO_COMMIT_NUDGE);
    assert.equal(ctx.events().length, 0, 'no hub event before the nudge has had time');

    ctx.clock.advance(14);
    await service.tick();
    assert.equal(ctx.events().length, 0, 'still inside the 15 min grace');

    ctx.clock.advance(1);
    await service.tick();
    const events = ctx.events();
    assert.equal(events.length, 1, 'one hub event after 15 min');
    assert.equal(events[0]!.jobId, 'no-commit');
    assert.match(events[0]!.reason, /no commit for \d+m/);

    await service.tick();
    ctx.clock.advance(60);
    await service.tick();
    assert.equal(ctx.events().length, 1, 'one event per unchanged HEAD');
  });
});

test('no commit: a busy job with fresh commits never fires', async () => {
  await withHealthContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const job = ctx.createJob('fresh', {
      state: 'active',
      in_turn: 1,
      session_id: 'session-fresh',
      created_at: new Date(ctx.clock.now.getTime() - 3 * 60 * 60_000).toISOString(),
    });
    startBusy(job.session_id!);
    ctx.heads.set('fresh', { sha: 'bbb', committedAtMs: ctx.clock.now.getTime() - 5 * 60_000 });
    const service = serviceFor(ctx);

    await service.tick();
    ctx.clock.advance(10);
    await service.tick();
    assert.equal(ctx.sent.length, 0);
    assert.equal(ctx.events().length, 0);

    // A new commit resets the clock.
    ctx.heads.set('fresh', { sha: 'ccc', committedAtMs: ctx.clock.now.getTime() });
    await service.tick();
    ctx.clock.advance(44);
    await service.tick();
    assert.equal(ctx.sent.length, 0, 'fresh commit keeps the job healthy');
    assert.equal(ctx.events().length, 0);
  });
});

test('overtime: fires once at maxRunMin and again only after the 30 min debounce', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('long', {
      state: 'active',
      created_at: new Date(ctx.clock.now.getTime() - 31 * 60_000).toISOString(),
      // No activity since it started: an observably idle run, not a live one.
      updated_at: new Date(ctx.clock.now.getTime() - 31 * 60_000).toISOString(),
    });
    const service = serviceFor(ctx);

    await service.tick();
    let events = ctx.events();
    assert.equal(events.length, 1);
    assert.match(events[0]!.reason, /over 30 min: split or stop/);

    ctx.clock.advance(10);
    await service.tick();
    assert.equal(ctx.events().length, 1, 'debounced inside 30 min');

    ctx.clock.advance(20);
    await service.tick();
    events = ctx.events();
    assert.equal(events.length, 2, 'repeats after 30 min');
  });
});

test('dead slot: a failed turn holding a slot fires once after deadSlotMin', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('dead', {
      state: 'active',
      in_turn: 0,
      last_error: 'The last turn ended with exit code 1',
      updated_at: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    });
    const service = serviceFor(ctx);

    await service.tick();
    const events = ctx.events();
    assert.equal(events.length, 1);
    assert.match(events[0]!.reason, /holding a slot: cancel or resume/);

    await service.tick();
    ctx.clock.advance(10);
    await service.tick();
    assert.equal(ctx.events().length, 1, 'debounced');
  });
});

test('health flags are exposed for status and disabled config emits nothing', async () => {
  await withHealthContext(async (ctx) => {
    const job = ctx.createJob('flagged', {
      state: 'active',
      in_turn: 1,
      session_id: 'session-flagged',
      created_at: new Date(ctx.clock.now.getTime() - 50 * 60_000).toISOString(),
      updated_at: new Date(ctx.clock.now.getTime() - 50 * 60_000).toISOString(),
    });
    ctx.heads.set('flagged', { sha: 'ddd', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });
    const service = serviceFor(ctx);
    await service.tick();

    const flags = service.flags().get('flagged') ?? [];
    assert.ok(flags.some((flag) => flag.condition === 'no_commit'));
    assert.ok(flags.some((flag) => flag.condition === 'overtime'));

    ctx.config.health.enabled = false;
    const before = ctx.events().length;
    await service.tick();
    assert.equal(ctx.events().length, before, 'disabled health emits nothing');
    assert.equal(service.flags().size, 0);
  });
});

test('no commit: a real busy run refuses the nudge, so the hub is told now and in_turn is kept', async () => {
  await withHealthContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const jobs = await realJobsService(ctx);
    const sessionId = sessionsDb.createSession('sess-real-busy', 'claude', ctx.dir, 'Real busy');
    const job = ctx.createJob('real-busy', {
      state: 'active',
      in_turn: 1,
      session_id: sessionId,
      backend: 'claude',
      created_at: new Date(ctx.clock.now.getTime() - 60 * 60_000).toISOString(),
    });
    startBusy(sessionId);
    ctx.heads.set('real-busy', { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });

    // Exactly the module wiring: health -> jobs.notifyWithOutcome -> runDetachedChatTurn.
    const service = createHealthService({
      config: () => ctx.config,
      now: () => ctx.clock.now,
      readHead: async (worktreePath) => ctx.heads.get(path.basename(worktreePath)) ?? null,
      sendToJob: (row, message) => jobs.notifyWithOutcome(row, message),
    });

    await service.tick();
    const events = ctx.events();
    assert.equal(events.length, 1, 'a refused nudge escalates to the hub instead of waiting 15 impossible minutes');
    assert.match(events[0]!.reason, /no commit for \d+m/);
    assert.equal((orchestratorJobsDb.get(job.id) as OrchestratorJobRow).in_turn, 1, 'the live run keeps its in_turn flag');
    assert.equal(chatRunRegistry.isProcessing(sessionId), true, 'the run is still processing');

    ctx.clock.advance(60);
    await service.tick();
    assert.equal(ctx.events().length, 1, 'one event per unchanged HEAD');
  });
});

test('dead slot: an armed auto-recovery is not waiting for the hub, a gave-up one still is', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('armed', {
      state: 'active',
      in_turn: 0,
      backend: 'claude',
      last_error: 'usage_limit: usage cap reached; the provider stated a reset',
      limit_recovery: armedRecovery(ctx),
      created_at: new Date(ctx.clock.now.getTime() - 2 * 60_000).toISOString(),
      updated_at: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    });
    ctx.createJob('gave-up', {
      state: 'active',
      in_turn: 0,
      backend: 'claude',
      last_error: 'usage_limit: usage cap reached; the provider stated a reset',
      limit_recovery: armedRecovery(ctx, true),
      created_at: new Date(ctx.clock.now.getTime() - 2 * 60_000).toISOString(),
      updated_at: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    });
    const service = serviceFor(ctx);

    await service.tick();
    const events = ctx.events();
    assert.equal(events.length, 1, 'only the gave-up recovery holds a slot for the hub');
    assert.equal(events[0]!.jobId, 'gave-up');
    assert.match(events[0]!.reason, /holding a slot: cancel or resume/);
  });
});

test('dead slot: a successful non-aborted turn clears a stale usage-limit last_error', async () => {
  await withHealthContext(async (ctx) => {
    const jobs = await realJobsService(ctx);
    const sessionId = sessionsDb.createSession('sess-recovered', 'claude', ctx.dir, 'Recovered');
    const job = ctx.createJob('recovered', {
      state: 'active',
      in_turn: 0,
      session_id: sessionId,
      backend: 'claude',
      last_error: 'usage_limit: usage cap reached; the provider stated a reset',
      limit_recovery: null,
      updated_at: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    });

    jobs.handleRunCompleted({ appSessionId: sessionId, exitCode: 0, aborted: false });
    await jobs.afterCheckpoints();

    assert.equal((orchestratorJobsDb.get(job.id) as OrchestratorJobRow).last_error, null, 'the stale error is gone');
    const service = serviceFor(ctx);
    await service.tick();
    assert.equal(ctx.events().filter((event) => event !== null && /cancel or resume/.test(event.reason)).length, 0, 'no dead-slot alert for a healthy job');
  });
});

test('overtime: fresh activity at the same age is healthy, unchanged old activity is overdue', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('live', {
      state: 'active',
      created_at: new Date(ctx.clock.now.getTime() - 31 * 60_000).toISOString(),
      updated_at: ctx.clock.now.toISOString(),
    });
    ctx.createJob('idle', {
      state: 'active',
      created_at: new Date(ctx.clock.now.getTime() - 31 * 60_000).toISOString(),
      updated_at: new Date(ctx.clock.now.getTime() - 31 * 60_000).toISOString(),
    });
    const service = serviceFor(ctx);

    await service.tick();
    const events = ctx.events();
    assert.equal(events.length, 1, 'only the idle run is overdue');
    assert.equal(events[0]!.jobId, 'idle');
    assert.match(events[0]!.reason, /over 30 min: split or stop/);

    const flags = service.flags();
    assert.equal(flags.has('live'), false, 'live work is not flagged overtime');
    assert.ok(flags.get('idle')?.some((flag) => flag.condition === 'overtime'));
  });
});

test('no commit: a job cancelled during the tick receives no hub event', async () => {
  await withHealthContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const job = ctx.createJob('cancelled-mid-tick', {
      state: 'active',
      in_turn: 1,
      session_id: 'session-cancelled-mid-tick',
      created_at: new Date(ctx.clock.now.getTime() - 60 * 60_000).toISOString(),
    });
    startBusy(job.session_id!);
    ctx.heads.set('cancelled-mid-tick', { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });

    let calls = 0;
    const service = serviceFor(ctx, {
      readHead: async (worktreePath) => {
        calls += 1;
        if (calls === 2) orchestratorJobsDb.update(job.id, { state: 'cancelled', in_turn: 0 });
        return ctx.heads.get(path.basename(worktreePath)) ?? null;
      },
    });

    await service.tick();
    assert.equal(ctx.sent.length, 1);
    ctx.clock.advance(16);
    await service.tick();

    assert.equal((orchestratorJobsDb.get(job.id) as OrchestratorJobRow).state, 'cancelled');
    assert.equal(ctx.events().length, 0, 'the event is dropped after the row is re-read');
  });
});

test('no commit: a non-finite committedAtMs from an injected reader fails closed', async () => {
  await withHealthContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const job = ctx.createJob('nan-head', {
      state: 'active',
      in_turn: 1,
      session_id: 'session-nan-head',
      created_at: new Date(ctx.clock.now.getTime() - 3 * 60 * 60_000).toISOString(),
    });
    startBusy(job.session_id!);
    ctx.heads.set('nan-head', { sha: 'yyy', committedAtMs: Number.NaN });
    const service = serviceFor(ctx);

    await service.tick();
    assert.equal(ctx.sent.length, 0, 'no nudge from a non-finite commit time');
    assert.equal(ctx.events().length, 0);
  });
});

test('rename persists the new title and records the old one in history', async () => {
  await withHealthContext(async (ctx) => {
    const job = ctx.createJob('rename-me', { title: 'Old title' });
    const { createJobsService } = await import('../services/jobs.service.js');
    const jobs = createJobsService({
      runtime: {
        hasRuntime: () => true,
        hasBackgroundWork: () => false,
        stopBackgroundTask: async () => false,
        resolveToolApproval: () => undefined,
        getPendingApprovalsForSession: () => [],
        abort: async () => true,
        run: async () => undefined,
      },
      config: () => ctx.config,
      probeZcode: async () => ({ ok: true }),
      morphUsage: { usage: () => ({ source: 'none', at: ctx.clock.now.toISOString(), groups: { kimi: { group: 'kimi', uncachedIn: 0, out: 0, caps: { uncachedIn: 1, out: 1 }, minutes: [] }, deepseek: { group: 'deepseek', uncachedIn: 0, out: 0, caps: { uncachedIn: 1, out: 1 }, minutes: [] } } }), admitted: () => true },
    });

    const renamed = await jobs.rename(job.id, 'Plain outcome');
    assert.equal(renamed.title, 'Plain outcome');
    assert.equal(jobs.get(job.id)?.title, 'Plain outcome');
    const history = readTitleHistory(orchestratorJobsDb.get(job.id)!);
    assert.equal(history.length, 1);
    assert.equal(history[0].from, 'Old title');
    assert.equal(history[0].to, 'Plain outcome');
    assert.ok(jobs.list().some((entry) => entry.id === job.id && entry.title === 'Plain outcome'));
  });
});

function minutesAgo(ctx: { clock: { now: Date } }, min: number): string {
  return new Date(ctx.clock.now.getTime() - min * 60_000).toISOString();
}

test('health cooldowns: a restart inside the debounce does not re-emit the same condition', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('restart-overtime', {
      state: 'active',
      created_at: minutesAgo(ctx, 31),
      updated_at: minutesAgo(ctx, 31),
    });
    const first = serviceFor(ctx);
    await first.tick();
    assert.equal(ctx.events().length, 1, 'the overtime condition fires once');

    ctx.clock.advance(10);
    const restarted = serviceFor(ctx);
    await restarted.tick();
    assert.equal(ctx.events().length, 1, 'a restart inside the 30 min debounce does not re-emit');

    ctx.clock.advance(25);
    await restarted.tick();
    assert.equal(ctx.events().length, 2, 'an older deliveredAt is honored after 30 min');
  });
});

test('health cooldowns: a resolved condition does not alert after restart', async () => {
  await withHealthContext(async (ctx) => {
    const job = ctx.createJob('resolved-condition', {
      state: 'active',
      created_at: minutesAgo(ctx, 31),
      updated_at: minutesAgo(ctx, 31),
    });
    const first = serviceFor(ctx);
    await first.tick();
    assert.equal(ctx.events().length, 1);

    orchestratorJobsDb.update(job.id, { state: 'cancelled' });
    ctx.clock.advance(10);
    const restarted = serviceFor(ctx);
    await restarted.tick();
    assert.equal(ctx.events().length, 1, 'a condition that no longer holds emits nothing');
  });
});

test('health cooldowns: jobs and conditions are isolated', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('iso-a', { state: 'active', created_at: minutesAgo(ctx, 31), updated_at: minutesAgo(ctx, 31) });
    ctx.createJob('iso-b', { state: 'active', created_at: minutesAgo(ctx, 31), updated_at: minutesAgo(ctx, 31) });
    const first = serviceFor(ctx);
    await first.tick();
    assert.equal(ctx.events().length, 2);

    ctx.clock.advance(10);
    const restarted = serviceFor(ctx);
    await restarted.tick();
    assert.equal(ctx.events().length, 2, 'both jobs keep their own cooldown');

    ctx.createJob('iso-c', { state: 'active', created_at: minutesAgo(ctx, 31), updated_at: minutesAgo(ctx, 31) });
    await restarted.tick();
    assert.equal(ctx.events().length, 3, 'a job without a cooldown still alerts');
  });
});

test('health cooldowns: a different condition on the same job is not suppressed', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('iso-condition', {
      state: 'active',
      created_at: minutesAgo(ctx, 60),
      updated_at: minutesAgo(ctx, 30),
      last_error: 'failed',
    });
    const first = serviceFor(ctx);
    await first.tick();
    assert.equal(ctx.events().length, 2, 'overtime and dead_slot both fire');

    ctx.clock.advance(10);
    const restarted = serviceFor(ctx);
    await restarted.tick();
    assert.equal(ctx.events().length, 2, 'each condition keeps its own cooldown');
  });
});

test('health cooldowns: an older persisted deliveredAt is honored', async () => {
  await withHealthContext(async (ctx) => {
    const oldJob = ctx.createJob('old-cooldown', {
      state: 'active',
      created_at: minutesAgo(ctx, 31),
      updated_at: minutesAgo(ctx, 31),
    });
    const recentJob = ctx.createJob('recent-cooldown', {
      state: 'active',
      created_at: minutesAgo(ctx, 31),
      updated_at: minutesAgo(ctx, 31),
    });
    appConfigDb.set('orchestrator.job_health_cooldowns', JSON.stringify({
      version: 1,
      cooldowns: {
        [`${oldJob.id}:overtime`]: { at: ctx.clock.now.getTime() - 31 * 60_000, marker: oldJob.created_at },
        [`${recentJob.id}:overtime`]: { at: ctx.clock.now.getTime() - 10 * 60_000, marker: recentJob.created_at },
      },
    }));

    const service = serviceFor(ctx);
    await service.tick();
    assert.deepEqual(ctx.events().filter((event) => event !== null).map((event) => event.jobId), [oldJob.id]);
  });
});

test('health cooldowns: a failing persistence write does not spam alerts', async () => {
  await withHealthContext(async (ctx) => {
    ctx.createJob('failing-store', {
      state: 'active',
      created_at: minutesAgo(ctx, 31),
      updated_at: minutesAgo(ctx, 31),
    });
    const failing = {
      load: () => ({}),
      save: () => {
        throw new Error('disk full');
      },
    };
    const service = serviceFor(ctx, { cooldownPersistence: failing });
    await service.tick();
    await service.tick();
    await service.tick();
    assert.equal(ctx.events().length, 1, 'the in-process debounce still holds when the write fails');

    const restarted = serviceFor(ctx, { cooldownPersistence: failing });
    await restarted.tick();
    await restarted.tick();
    assert.equal(ctx.events().length, 2, 'a restart loses the guard but emits once, not per tick');
  });
});
