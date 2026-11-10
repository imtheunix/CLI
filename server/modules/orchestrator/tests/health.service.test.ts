import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
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
import type { WorktreeHead } from '../services/health.service.js';
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
}) {
  return createHealthService({
    config: () => ctx.config,
    now: () => ctx.clock.now,
    readHead: async (worktreePath) => ctx.heads.get(path.basename(worktreePath)) ?? null,
    sendToJob: async (job, message) => {
      ctx.sent.push({ jobId: job.id, message });
      return true;
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
    });
    startBusy(job.session_id!);
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
