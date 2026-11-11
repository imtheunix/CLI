import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  orchestratorJobsDb,
  runningTurnsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ZcodeProbeOptions, ZcodeProbeResult } from '@/shared/types.js';

import { createHealthService, NO_COMMIT_NUDGE } from '../services/health.service.js';
import type { HealthDependencies, WorktreeHead } from '../services/health.service.js';
import { parseHubEventLine } from '../services/hub-wake.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';

// Refutation probes for job 801ee02f: they re-test the corrected stall alerts of
// ab3b7d53 against the real health -> jobs.notifyWithOutcome -> runDetachedChatTurn
// wiring, with synthetic job lifecycles only (temp DB, temp event log, injected
// clocks/heads, registry runs nobody dispatches). No real model, provider or hub
// contact; the fake runtime refuses or no-ops every dispatch.

type Sent = { jobId: string; message: string };
type ParsedEvent = NonNullable<ReturnType<typeof parseHubEventLine>>;
type RuntimeCalls = { inject: number; abort: number; run: number };

type ProbeCtx = {
  dir: string;
  eventsLogPath: string;
  config: OrchestratorConfig;
  clock: { now: Date; advance: (min: number) => void };
  heads: Map<string, WorktreeHead>;
  sent: Sent[];
  createJob: (id: string, overrides?: Partial<OrchestratorJobRow>) => OrchestratorJobRow;
  newSession: (name: string, provider?: string, jsonlPath?: string | null) => string;
  events: () => ParsedEvent[];
  eventsFor: (jobId: string) => ParsedEvent[];
  setTimestamps: (id: string, createdAt: string, updatedAt: string) => void;
  rawSetState: (id: string, state: string) => void;
  rawDeleteJob: (id: string) => void;
};

/** A fake runtime gateway: records steering attempts, never talks to a provider. */
function fakeRuntime() {
  const calls: RuntimeCalls = { inject: 0, abort: 0, run: 0 };
  let runtimeAvailable = true;
  return {
    calls,
    setAvailability: (available: boolean) => {
      runtimeAvailable = available;
    },
    gateway: {
      hasRuntime: () => runtimeAvailable,
      hasBackgroundWork: () => false,
      stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
      abort: async () => {
        calls.abort += 1;
        return true;
      },
      run: async () => {
        calls.run += 1;
        return undefined;
      },
      inject: async () => {
        calls.inject += 1;
        return false;
      },
    },
  };
}

async function realJobsService(ctx: ProbeCtx, runtimeGateway: ReturnType<typeof fakeRuntime>['gateway'], probeZcode?: (options?: ZcodeProbeOptions) => Promise<ZcodeProbeResult>) {
  const { createJobsService } = await import('../services/jobs.service.js');
  return createJobsService({
    runtime: runtimeGateway,
    config: () => ctx.config,
    probeZcode: probeZcode ?? (async () => ({ ok: true })),
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

/** Registers a synthetic run in the in-memory registry; nothing is ever dispatched. */
function startBusy(sessionId: string, provider = 'claude'): void {
  chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: provider as 'claude',
    providerSessionId: `provider-${sessionId}`,
    connection: null,
    userId: null,
  });
}

async function withProbeContext(fn: (ctx: ProbeCtx) => Promise<void>, clockMode: 'fixed' | 'real' = 'fixed') {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousEventsLog = process.env.CLI_HUB_EVENTS_LOG;
  const dir = await mkdtemp(path.join(tmpdir(), 'health-refute-801ee02f-'));
  const eventsLogPath = path.join(dir, 'hub-events.log');

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  process.env.CLI_HUB_EVENTS_LOG = eventsLogPath;
  await initializeDatabase();
  userDb.createUser('testuser', 'hash');

  const config = loadOrchestratorConfig(path.join(dir, 'none.json'));
  config.health = { enabled: true, noCommitMin: 45, maxRunMin: 30, deadSlotMin: 20 };
  const base = clockMode === 'fixed' ? new Date('2026-11-10T12:00:00.000Z') : new Date();
  const clock = {
    now: new Date(base.getTime()),
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
    const createdAt = overrides.created_at ?? clock.now.toISOString();
    const updatedAt = overrides.updated_at ?? clock.now.toISOString();
    getConnection().prepare('UPDATE orchestrator_jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, updatedAt, id);
    return orchestratorJobsDb.get(id) as OrchestratorJobRow;
  };

  const newSession = (name: string, provider = 'claude', jsonlPath: string | null = null): string =>
    sessionsDb.createSession(`provider-${name}`, provider, dir, name, undefined, undefined, jsonlPath);

  const events = () => {
    if (!existsSync(eventsLogPath)) return [];
    return readFileSync(eventsLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map(parseHubEventLine)
      .filter((event): event is ParsedEvent => event !== null);
  };
  const eventsFor = (jobId: string) => events().filter((event) => event.jobId === jobId);

  const setTimestamps = (id: string, createdAt: string, updatedAt: string) => {
    getConnection().prepare('UPDATE orchestrator_jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, updatedAt, id);
  };
  // Raw SQL state flips keep updated_at untouched, so a guard test is not masked
  // by a freshness write the production cancellation path would not make here.
  const rawSetState = (id: string, state: string) => {
    getConnection().prepare('UPDATE orchestrator_jobs SET state = ? WHERE id = ?').run(state, id);
  };
  const rawDeleteJob = (id: string) => {
    getConnection().prepare('DELETE FROM orchestrator_jobs WHERE id = ?').run(id);
  };

  try {
    await fn({ dir, eventsLogPath, config, clock, heads, sent, createJob, newSession, events, eventsFor, setTimestamps, rawSetState, rawDeleteJob });
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

/** Health wired exactly like OrchestratorModule: sendToJob -> jobs.notifyWithOutcome. */
function moduleWiredHealth(ctx: ProbeCtx, jobs: { notifyWithOutcome: (job: OrchestratorJobRow, message: string) => Promise<{ started: boolean; refused: boolean }> }, onSend?: (job: OrchestratorJobRow, message: string) => Promise<{ started: boolean; refused: boolean }>) {
  return createHealthService({
    config: () => ctx.config,
    now: () => ctx.clock.now,
    readHead: async (worktreePath) => ctx.heads.get(path.basename(worktreePath)) ?? null,
    sendToJob: async (job, message) => {
      ctx.sent.push({ jobId: job.id, message });
      return onSend ? onSend(job, message) : jobs.notifyWithOutcome(job, message);
    },
  });
}

function injectedHealth(ctx: ProbeCtx, overrides: Partial<HealthDependencies> = {}) {
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

function armedRecoveryJson(ctx: ProbeCtx, kind: 'usage_limit' | 'auth_required', gaveUp = false): string {
  return JSON.stringify({
    key: `recovery-${kind}`,
    kind,
    resetAt: new Date(ctx.clock.now.getTime() + 2 * 60 * 60_000).toISOString(),
    dueAt: new Date(ctx.clock.now.getTime() + 2 * 60 * 60_000).toISOString(),
    attempt: 1,
    firstFailedAt: new Date(ctx.clock.now.getTime() - 21 * 60_000).toISOString(),
    delivered: false,
    gaveUp,
    reason: kind === 'usage_limit' ? 'usage cap reached; the provider stated a reset' : 'zcode login failed',
  });
}

const minutesAgoIso = (ctx: ProbeCtx, min: number) => new Date(ctx.clock.now.getTime() - min * 60_000).toISOString();

test('F1: a genuinely busy run stays quiet and owns its session; no false stall escalation', async () => {
  await withProbeContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const runtime = fakeRuntime();
    const jobs = await realJobsService(ctx, runtime.gateway);
    const sessionId = ctx.newSession('refute-f1');
    const job = ctx.createJob('refute-f1', {
      state: 'active',
      in_turn: 1,
      session_id: sessionId,
      backend: 'claude',
      created_at: minutesAgoIso(ctx, 60),
    });
    startBusy(sessionId);
    ctx.heads.set('refute-f1', { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });
    const health = moduleWiredHealth(ctx, jobs);

    await health.tick();
    let jobEvents = ctx.eventsFor('refute-f1');
    assert.equal(ctx.sent.length, 1, 'the nudge path was attempted exactly once');
    assert.equal(ctx.sent[0].message, NO_COMMIT_NUDGE);
    assert.equal(jobEvents.length, 0, 'a refused nudge is evidence of real work, not a stalled session');
    assert.equal((orchestratorJobsDb.get(job.id) as OrchestratorJobRow).in_turn, 1, 'the live run keeps in_turn');
    assert.equal(chatRunRegistry.isProcessing(sessionId), true, 'the run is untouched');
    assert.equal(runtime.calls.inject, 0, 'the refusal never steered or injected into a live run');
    assert.equal(runtime.calls.abort, 0, 'the refusal never aborted a live run');
    assert.equal(runtime.calls.run, 0, 'no turn was dispatched anywhere');

    ctx.clock.advance(10);
    await health.tick();
    ctx.clock.advance(50);
    await health.tick();
    assert.ok(ctx.sent.length > 1, 'liveness probes may retry while the run is busy');
    assert.ok(ctx.sent.every((sent) => sent.message === NO_COMMIT_NUDGE), 'the busy run is never resumed');
    assert.equal(runtime.calls.inject, 0, 'no inject across repeated busy checks');
    assert.equal(runtime.calls.abort, 0, 'no abort across repeated busy checks');
    assert.equal(runtime.calls.run, 0, 'no overlapping run across repeated busy checks');
    assert.equal(ctx.eventsFor('refute-f1').length, 0, 'no false escalation after an hour of busy work');
  });
});

test('F1: a sendTurn failure keeps in_turn while another registered run owns the session', async () => {
  await withProbeContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const runtime = fakeRuntime();
    const sessionId = ctx.newSession('crosstalk', 'glm');
    // The probe hook stands in for the ZCode login probe: while sendTurnOutcome is
    // inside that await, another run takes the session, so the turn it then tries
    // to start is refused by the live run (exactly runDetachedChatTurn's busy gate).
    const jobs = await realJobsService(ctx, runtime.gateway, async () => {
      startBusy(sessionId, 'glm');
      return { ok: true };
    });
    const job = ctx.createJob('crosstalk', {
      state: 'active',
      in_turn: 0,
      session_id: sessionId,
      backend: 'glm',
    });

    const outcome = await jobs.notifyWithOutcome(job, 'nudge');
    assert.deepEqual(outcome, { started: false, refused: true }, 'the busy session refuses the turn');
    assert.equal((orchestratorJobsDb.get(job.id) as OrchestratorJobRow).in_turn, 1, 'a failed send does not clear in_turn while a registered run owns the session');
    assert.equal(chatRunRegistry.isProcessing(sessionId), true, 'the owning run is still processing');
    assert.equal(runtime.calls.inject, 0, 'no steer/inject into the live run');
    assert.equal(runtime.calls.abort, 0, 'no abort of the live run');
    assert.equal(runtime.calls.run, 0, 'no turn was dispatched anywhere');

    // Control: the same failure with nobody owning the session clears in_turn.
    runtime.setAvailability(false);
    const sessionId2 = ctx.newSession('crosstalk2', 'claude');
    const job2 = ctx.createJob('crosstalk2', {
      state: 'active',
      in_turn: 1,
      session_id: sessionId2,
      backend: 'claude',
    });
    const outcome2 = await jobs.notifyWithOutcome(job2, 'nudge');
    assert.deepEqual(outcome2, { started: false, refused: true });
    assert.equal((orchestratorJobsDb.get(job2.id) as OrchestratorJobRow).in_turn, 0, 'with no run owning the session the flag is repaired');
  });
});

test('F2: an armed auth recovery is silent; a successful turn clears an armed recovery and its stale error', async () => {
  await withProbeContext(async (ctx) => {
    ctx.createJob('armed-auth', {
      state: 'active',
      in_turn: 0,
      backend: 'claude',
      last_error: 'auth_required: zcode login failed',
      limit_recovery: armedRecoveryJson(ctx, 'auth_required'),
      created_at: minutesAgoIso(ctx, 2),
      updated_at: minutesAgoIso(ctx, 21),
    });
    ctx.createJob('gave-up-auth', {
      state: 'active',
      in_turn: 0,
      backend: 'claude',
      last_error: 'auth_required: zcode login failed',
      limit_recovery: armedRecoveryJson(ctx, 'auth_required', true),
      created_at: minutesAgoIso(ctx, 2),
      updated_at: minutesAgoIso(ctx, 21),
    });
    const health = injectedHealth(ctx);
    await health.tick();

    const events = ctx.events();
    assert.equal(events.length, 1, 'only the gave-up auth recovery holds a slot for the hub');
    assert.equal(events[0].jobId, 'gave-up-auth');
    assert.match(events[0].reason, /holding a slot: cancel or resume/);
    const flags = health.flags();
    assert.equal(flags.has('armed-auth'), false, 'the armed recovery gets no dead_slot flag either');

    // Residue variant: a successful non-aborted turn clears an ARMED recovery and
    // its stale usage-limit error, so the job can never dead-slot on it.
    const runtime = fakeRuntime();
    const jobs = await realJobsService(ctx, runtime.gateway);
    const sessionId = ctx.newSession('recovered-armed');
    const job = ctx.createJob('recovered-armed', {
      state: 'active',
      in_turn: 0,
      session_id: sessionId,
      backend: 'claude',
      last_error: 'usage_limit: usage cap reached; the provider stated a reset',
      limit_recovery: armedRecoveryJson(ctx, 'usage_limit'),
    });
    jobs.handleRunCompleted({ appSessionId: sessionId, exitCode: 0, aborted: false });
    await jobs.afterCheckpoints();
    const row = orchestratorJobsDb.get(job.id) as OrchestratorJobRow;
    assert.equal(row.last_error, null, 'the stale usage-limit error is gone');
    assert.equal(row.limit_recovery, null, 'the armed recovery is disarmed by a successful turn');
    assert.equal(row.failure_class, null);
    const health2 = injectedHealth(ctx);
    await health2.tick();
    assert.equal(ctx.eventsFor('recovered-armed').filter((event) => /cancel or resume/.test(event.reason)).length, 0, 'no dead-slot alert for the recovered job');
  });
});

test('F3: overtime follows transcript, running-turn and registry activity; stale activity still alerts', async () => {
  await withProbeContext(async (ctx) => {
    const nowMs = Date.now();
    const service = injectedHealth(ctx);
    const mtime = (filePath: string, ms: number) => utimesSync(filePath, new Date(ms), new Date(ms));

    // Transcript source: a 60-minute-old job whose jsonl was written just now.
    const transcript = path.join(ctx.dir, 'live-transcript.jsonl');
    writeFileSync(transcript, '{}');
    const sessionId = ctx.newSession('live-transcript', 'claude', transcript);
    ctx.createJob('live-transcript', {
      state: 'active',
      session_id: sessionId,
      created_at: minutesAgoIso(ctx, 60),
      updated_at: minutesAgoIso(ctx, 60),
    });
    mtime(transcript, nowMs);
    await service.tick();
    assert.equal(ctx.eventsFor('live-transcript').length, 0, 'fresh transcript activity is not overtime, however old the job is');
    assert.equal((service.flags().get('live-transcript') ?? []).some((flag) => flag.condition === 'overtime'), false);

    // The same job with a stale transcript (only source) is overdue: this pins the
    // transcript source to the gate in both directions.
    mtime(transcript, nowMs - 45 * 60_000);
    await service.tick();
    const overtime = ctx.eventsFor('live-transcript');
    assert.equal(overtime.length, 1, 'a 45-minutes-stale transcript makes the 60-minute job overdue');
    assert.match(overtime[0].reason, /over 30 min: split or stop/);
    assert.equal((service.flags().get('live-transcript') ?? []).some((flag) => flag.condition === 'overtime'), true, 'flags agree with events');

    // Running-turn source: log mtime and started_at keep the job alive.
    const turnLog = path.join(ctx.dir, 'live-turnrow.log');
    writeFileSync(turnLog, 'output');
    const sessionId2 = ctx.newSession('live-turnrow');
    ctx.createJob('live-turnrow', {
      state: 'active',
      session_id: sessionId2,
      created_at: minutesAgoIso(ctx, 60),
      updated_at: minutesAgoIso(ctx, 60),
    });
    runningTurnsDb.recordTurn({
      unitName: 'turn-live-turnrow',
      sessionId: sessionId2,
      backend: 'claude',
      logPath: turnLog,
      startedAt: new Date(nowMs).toISOString(),
    });
    mtime(turnLog, nowMs);
    await service.tick();
    assert.equal(ctx.eventsFor('live-turnrow').length, 0, 'a fresh detached-turn log/row is not overtime');

    runningTurnsDb.recordTurn({
      unitName: 'turn-live-turnrow',
      sessionId: sessionId2,
      backend: 'claude',
      logPath: turnLog,
      startedAt: new Date(nowMs - 45 * 60_000).toISOString(),
    });
    mtime(turnLog, nowMs - 45 * 60_000);
    await service.tick();
    assert.equal(ctx.eventsFor('live-turnrow').length, 1, 'a stale detached-turn log and start make the job overdue');

    // Registry source: a run started just now keeps the job alive; a cleared
    // registry exposes the stale row.
    const sessionId3 = ctx.newSession('live-registry');
    ctx.createJob('live-registry', {
      state: 'active',
      session_id: sessionId3,
      created_at: minutesAgoIso(ctx, 60),
      updated_at: minutesAgoIso(ctx, 60),
    });
    startBusy(sessionId3);
    await service.tick();
    assert.equal(ctx.eventsFor('live-registry').length, 0, 'a just-started registered run is not overtime');
    chatRunRegistry.clearAll();
    await service.tick();
    assert.equal(ctx.eventsFor('live-registry').length, 1, 'with no run and only a stale row the job is overdue');

    // Idle control: a long job with no activity anywhere is identified on sight.
    ctx.createJob('idle-long', {
      state: 'active',
      created_at: minutesAgoIso(ctx, 60),
      updated_at: minutesAgoIso(ctx, 60),
    });
    await service.tick();
    assert.equal(ctx.eventsFor('idle-long').length, 1, 'an actually idle long-running job is still identified');
    assert.match(ctx.eventsFor('idle-long')[0].reason, /over 30 min: split or stop/);
  }, 'real');
});

test('F5: cancellation, completion and row replacement inside the nudge gap suppress the stale hub event', async () => {
  await withProbeContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;
    const runtime = fakeRuntime();
    const jobs = await realJobsService(ctx, runtime.gateway);
    const oldCreated = minutesAgoIso(ctx, 60);

    const makeNudgeGapJob = (id: string): OrchestratorJobRow => {
      const sessionId = ctx.newSession(id);
      const job = ctx.createJob(id, {
        state: 'active',
        in_turn: 1,
        session_id: sessionId,
        backend: 'claude',
        created_at: oldCreated,
      });
      startBusy(sessionId);
      ctx.heads.set(id, { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });
      return job;
    };

    // The original probe-5 shape: the row is cancelled inside the async nudge gap.
    const cancelled = makeNudgeGapJob('gap-cancel');
    const healthCancelled = moduleWiredHealth(ctx, jobs, async (job, message) => {
      orchestratorJobsDb.update(job.id, { state: 'cancelled', in_turn: 0 });
      return jobs.notifyWithOutcome(job, message);
    });
    await healthCancelled.tick();
    assert.equal(ctx.sent.length, 1, 'the nudge was attempted');
    assert.equal(ctx.eventsFor('gap-cancel').length, 0, 'a job cancelled in the gap gets no event');

    // Completion in the same gap.
    const done = makeNudgeGapJob('gap-done');
    const healthDone = moduleWiredHealth(ctx, jobs, async (job, message) => {
      orchestratorJobsDb.update(job.id, { state: 'done' });
      return jobs.notifyWithOutcome(job, message);
    });
    await healthDone.tick();
    assert.equal(ctx.eventsFor('gap-done').length, 0, 'a finished job gets no event');

    // Replacement in the gap, same created_at but a new session: the session guard drops it.
    // Hooks only act on their own job: one tick visits every row in the shared DB.
    const replacedSession = makeNudgeGapJob('gap-repl-session');
    const healthReplSession = moduleWiredHealth(ctx, jobs, async (job, message) => {
      if (job.id !== 'gap-repl-session') return jobs.notifyWithOutcome(job, message);
      ctx.rawDeleteJob(job.id);
      ctx.createJob('gap-repl-session', { state: 'active', in_turn: 1, session_id: ctx.newSession('replacement'), backend: 'claude', created_at: oldCreated });
      return jobs.notifyWithOutcome(job, message);
    });
    await healthReplSession.tick();
    assert.equal(ctx.eventsFor('gap-repl-session').length, 0, 'a replaced row with a new session gets no event');

    // Replacement in the gap, same session but a new created_at: the created_at guard drops it.
    makeNudgeGapJob('gap-repl-created');
    const healthReplCreated = moduleWiredHealth(ctx, jobs, async (job, message) => {
      if (job.id !== 'gap-repl-created') return jobs.notifyWithOutcome(job, message);
      const oldSession = (orchestratorJobsDb.get(job.id) as OrchestratorJobRow).session_id;
      ctx.rawDeleteJob(job.id);
      ctx.createJob('gap-repl-created', { state: 'active', in_turn: 1, session_id: oldSession, backend: 'claude', created_at: minutesAgoIso(ctx, 90) });
      return jobs.notifyWithOutcome(job, message);
    });
    await healthReplCreated.tick();
    assert.equal(ctx.eventsFor('gap-repl-created').length, 0, 'a replaced row with a new created_at gets no event');
    assert.ok(replacedSession && done && cancelled, 'the gap jobs existed');
  });
});

test('F5: overtime and dead-slot emissions re-read the row immediately before emitting', async () => {
  await withProbeContext(async (ctx) => {
    // A job eligible for overtime (60m old, 40m since any row write) AND dead slot
    // (failed turn, idle 40m). Its row is deleted inside the readHead gap, before
    // either synchronous emission can run.
    ctx.createJob('gap-delete', {
      state: 'active',
      in_turn: 0,
      last_error: 'The last turn ended with exit code 1',
      created_at: minutesAgoIso(ctx, 60),
      updated_at: minutesAgoIso(ctx, 40),
    });
    let calls = 0;
    const health = injectedHealth(ctx, {
      readHead: async (worktreePath) => {
        calls += 1;
        ctx.rawDeleteJob(path.basename(worktreePath));
        return ctx.heads.get(path.basename(worktreePath)) ?? null;
      },
    });
    await health.tick();
    assert.equal(calls, 1);
    assert.equal(ctx.events().length, 0, 'neither overtime nor dead-slot fires for a deleted row');

    // A sibling job's readHead flips a dead-slot job to cancelled (raw SQL, so
    // updated_at stays stale and cannot mask the guard): the synchronous
    // checkDeadSlot still drops the event after re-reading the row.
    ctx.createJob('slot-victim', {
      state: 'active',
      in_turn: 0,
      last_error: 'The last turn ended with exit code 1',
      created_at: minutesAgoIso(ctx, 30),
      updated_at: minutesAgoIso(ctx, 21),
    });
    const killer = ctx.createJob('slot-killer', {
      state: 'active',
      in_turn: 1,
      session_id: ctx.newSession('slot-killer'),
      created_at: minutesAgoIso(ctx, 60),
    });
    startBusy(killer.session_id!);
    ctx.heads.set('slot-killer', { sha: 'aaa', committedAtMs: ctx.clock.now.getTime() - 50 * 60_000 });
    const health2 = injectedHealth(ctx, {
      readHead: async (worktreePath) => {
        if (path.basename(worktreePath) === 'slot-killer') ctx.rawSetState('slot-victim', 'cancelled');
        return ctx.heads.get(path.basename(worktreePath)) ?? null;
      },
    });
    await health2.tick();
    assert.equal(ctx.eventsFor('slot-victim').length, 0, 'a job cancelled mid-tick gets no dead-slot event');
    // The killer's own nudge was delivered, so its event correctly waits out the
    // 15-minute grace; the cancelled victim must stay silent through that window.
    ctx.clock.advance(16);
    await health2.tick();
    assert.equal(ctx.eventsFor('slot-victim').length, 0, 'the cancelled job stays silent after the grace too');
    assert.equal(ctx.eventsFor('slot-killer').length, 1, 'the live job still gets its own no-commit alert');
    assert.match(ctx.eventsFor('slot-killer')[0].reason, /no commit for/);
  });
});

test('F6: non-finite heads, malformed metadata, missing heads and empty worktrees fail safe', async () => {
  await withProbeContext(async (ctx) => {
    ctx.config.health.maxRunMin = 1_000;

    // Non-finite committedAtMs from an injected reader: fail closed, no nudge, no event.
    const busySession = ctx.newSession('nan-head');
    ctx.createJob('nan-head', { state: 'active', in_turn: 1, session_id: busySession, created_at: minutesAgoIso(ctx, 60) });
    startBusy(busySession);
    ctx.heads.set('nan-head', { sha: 'zzz', committedAtMs: Number.NaN });
    const infinityHealth = injectedHealth(ctx);
    await infinityHealth.tick();
    assert.equal(ctx.sent.length, 0, 'NaN commit time nudges nothing');
    ctx.heads.set('nan-head', { sha: 'zzz', committedAtMs: Number.POSITIVE_INFINITY });
    await infinityHealth.tick();
    assert.equal(ctx.sent.length, 0, 'Infinity nudges nothing');
    assert.equal(ctx.events().length, 0);

    // Garbage created_at: no overtime, no nudge, no crash, on the first tick.
    ctx.createJob('bad-created', { state: 'active', created_at: minutesAgoIso(ctx, 60) });
    ctx.setTimestamps('bad-created', 'not-a-date', minutesAgoIso(ctx, 60));
    const garbageHealth = injectedHealth(ctx);
    await garbageHealth.tick();
    assert.equal(ctx.eventsFor('bad-created').length, 0, 'unreadable created_at emits nothing');
    assert.equal(ctx.sent.filter((send) => send.jobId === 'bad-created').length, 0);
    assert.equal(garbageHealth.flags().has('bad-created'), false, 'flags stay empty instead of crashing');
    ctx.clock.advance(50);
    await garbageHealth.tick();
    assert.equal(ctx.eventsFor('bad-created').length, 0, 'still nothing once the fallback window would have passed');

    // Garbage updated_at with a failed-turn error: no dead slot, no overtime (under-alerts, never false-alerts).
    ctx.createJob('bad-updated', {
      state: 'active',
      in_turn: 0,
      last_error: 'The last turn ended with exit code 1',
      created_at: minutesAgoIso(ctx, 60),
    });
    ctx.setTimestamps('bad-updated', minutesAgoIso(ctx, 60), 'also-not-a-date');
    await garbageHealth.tick();
    assert.equal(ctx.eventsFor('bad-updated').length, 0, 'unreadable updated_at emits nothing');

    // Missing head read.
    const noHeadSession = ctx.newSession('no-head');
    ctx.createJob('no-head', { state: 'active', in_turn: 1, session_id: noHeadSession, created_at: minutesAgoIso(ctx, 60) });
    startBusy(noHeadSession);
    await garbageHealth.tick();
    assert.equal(ctx.eventsFor('no-head').length, 0, 'no head read emits nothing');
    assert.equal(ctx.sent.filter((send) => send.jobId === 'no-head').length, 0);

    // Empty worktree path.
    const emptyWtSession = ctx.newSession('empty-wt');
    ctx.createJob('empty-wt', { state: 'active', in_turn: 1, session_id: emptyWtSession, worktree_path: '', created_at: minutesAgoIso(ctx, 60) });
    startBusy(emptyWtSession);
    await garbageHealth.tick();
    assert.equal(ctx.eventsFor('empty-wt').length, 0, 'an empty worktree path emits nothing');
    assert.equal(ctx.sent.filter((send) => send.jobId === 'empty-wt').length, 0);
  });
});

test('F4 (deferred, expected present): cooldowns remain process-local across a simulated restart', async () => {
  await withProbeContext(async (ctx) => {
    ctx.createJob('restart-idle', {
      state: 'active',
      created_at: minutesAgoIso(ctx, 31),
      updated_at: minutesAgoIso(ctx, 31),
    });
    const before = injectedHealth(ctx);
    await before.tick();
    assert.equal(ctx.events().length, 1, 'the overtime condition fires once in-process');

    ctx.clock.advance(10);
    // A fresh service instance on the same DB/log stands in for a restarted process.
    const restarted = injectedHealth(ctx);
    await restarted.tick();
    assert.equal(ctx.events().length, 2, 'the deferred F4 defect is still present: a restart re-emits inside the 30 min debounce');

    ctx.clock.advance(10);
    await before.tick();
    assert.equal(ctx.events().length, 2, 'the pre-restart instance still holds its own debounce');
  });
});

test('F7 (deferred, expected unchanged): resume keeps created_at untouched', async () => {
  await withProbeContext(async (ctx) => {
    const runtime = fakeRuntime();
    const jobs = await realJobsService(ctx, runtime.gateway);
    const sessionId = ctx.newSession('retry-me');
    const job = ctx.createJob('retry-me', {
      state: 'cancelled',
      session_id: sessionId,
      created_at: minutesAgoIso(ctx, 90),
      updated_at: minutesAgoIso(ctx, 90),
    });
    mkdirSync(job.worktree_path, { recursive: true });
    const before = (orchestratorJobsDb.get(job.id) as OrchestratorJobRow).created_at;

    await jobs.resume(job.id);

    const after = orchestratorJobsDb.get(job.id) as OrchestratorJobRow;
    assert.equal(after.state, 'active', 'resume reactivates the cancelled job');
    assert.equal(after.created_at, before, 'created_at is not reset: the retry-created_at intent is unchanged (F7 deferred)');
  });
});
