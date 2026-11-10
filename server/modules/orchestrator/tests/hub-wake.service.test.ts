import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { appendHubEvent, getLiveHubEventsLogPath } from '../services/hub-events.service.js';
import { buildHubWakeMessage, createHubWakeService, hubWakeTestGuard } from '../services/hub-wake.service.js';
import type { LoggedHubEvent } from '../services/hub-wake.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';

type DispatchedTurn = {
  sessionId: string;
  command: string;
  options: Record<string, unknown>;
};

function createTestRuntime() {
  const turns: DispatchedTurn[] = [];
  const openTurns = new Map<string, () => void>();

  return {
    turns,
    finish(sessionId: string, options: { exitCode?: number; aborted?: boolean } = {}) {
      chatRunRegistry.completeRun(sessionId, {
        exitCode: options.exitCode ?? 0,
        aborted: options.aborted ?? false,
      });
      openTurns.get(sessionId)?.();
      openTurns.delete(sessionId);
    },
    clear() {
      for (const [sessionId, resolve] of openTurns) {
        chatRunRegistry.completeRun(sessionId, { exitCode: 0, aborted: true });
        resolve();
      }
      openTurns.clear();
      turns.length = 0;
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
        return new Promise<void>((resolve) => {
          openTurns.set(sessionId, resolve);
        });
      },
    },
  };
}

async function withTestContext(
  fn: (ctx: {
    dir: string;
    eventsLogPath: string;
    offsetPath: string;
    stallsPath: string;
    config: OrchestratorConfig;
    runtime: ReturnType<typeof createTestRuntime>;
    hubSessionId: string;
    userId: number;
    clock: { now: Date; advance: (sec: number) => void };
  }) => Promise<void>,
) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousEventsLog = process.env.CLI_HUB_EVENTS_LOG;

  const dir = await mkdtemp(path.join(tmpdir(), 'hub-wake-test-'));
  const dbPath = path.join(dir, 'test.db');
  const eventsLogPath = path.join(dir, 'hub-events.log');
  const offsetPath = path.join(dir, 'hub-events.log.offset');
  const stallsPath = path.join(dir, 'hub-events.log.stalls.json');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  process.env.CLI_HUB_EVENTS_LOG = eventsLogPath;
  await initializeDatabase();

  const user = userDb.createUser('testuser', 'hash');
  const userId = Number(user.id);
  const hubSessionId = 'hub-session-001';

  sessionsDb.createSession(
    hubSessionId,
    'claude',
    dir,
    'The HUB',
    new Date().toISOString(),
    new Date().toISOString(),
    path.join(dir, 'hub.jsonl'),
  );

  const config = loadOrchestratorConfig(path.join(dir, 'none.json'));
  config.hub = {
    sessionId: hubSessionId,
    wake: true,
    debounceSec: 90,
    stallMin: 30,
  };

  const runtime = createTestRuntime();
  const clock = {
    now: new Date(),
    advance: (sec: number) => {
      clock.now = new Date(clock.now.getTime() + sec * 1000);
    },
  };

  try {
    await fn({
      dir,
      eventsLogPath,
      offsetPath,
      stallsPath,
      config,
      runtime,
      hubSessionId,
      userId,
      clock,
    });
  } finally {
    runtime.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath) {
      process.env.DATABASE_PATH = previousDatabasePath;
    } else {
      delete process.env.DATABASE_PATH;
    }
    if (previousEventsLog) {
      process.env.CLI_HUB_EVENTS_LOG = previousEventsLog;
    } else {
      delete process.env.CLI_HUB_EVENTS_LOG;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

test('feature off when not configured or wake is false', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, clock }) => {
    // 1. Completely absent hub configuration
    delete config.hub;
    const serviceOff = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    serviceOff.start();

    appendHubEvent({
      jobId: 'job-1',
      state: 'review',
      title: 'First feature',
      reason: 'waiting for review',
    });

    clock.advance(100);
    await serviceOff.tick();

    assert.equal(runtime.turns.length, 0, 'no wake turn should be dispatched when hub is not configured');
    serviceOff.stop();

    // 2. hub configured with wake: false
    config.hub = {
      sessionId: 'hub-session-001',
      wake: false,
      debounceSec: 90,
      stallMin: 30,
    };
    const serviceDisabled = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    serviceDisabled.start();

    appendHubEvent({
      jobId: 'job-2',
      state: 'turn_ended',
      title: 'Second job',
      reason: 'turn ended without tjob done',
    });

    clock.advance(100);
    await serviceDisabled.tick();

    assert.equal(runtime.turns.length, 0, 'no wake turn when wake is false');
    serviceDisabled.stop();
  });
});

test('coalesces events within debounceSec into one turn, newest last', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, hubSessionId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service.start();

    // Event 1 at t=0
    appendHubEvent({
      jobId: '5a1082be',
      state: 'review',
      title: 'TSGE speed T3',
      reason: 'waiting for review',
      timestamp: clock.now.toISOString(),
    });

    // Event 2 at t=20s
    clock.advance(20);
    appendHubEvent({
      jobId: '1b2c3d4e',
      state: 'turn_ended',
      title: 'Fix typo',
      reason: 'turn ended without tjob done',
      timestamp: clock.now.toISOString(),
    });

    // At t=40s (within debounce window of 90s)
    clock.advance(20);
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'events should still be coalescing during debounceSec');

    // At t=120s (> 90s since last event)
    clock.advance(80);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'one coalesced wake turn should be dispatched');
    const turn = runtime.turns[0];
    assert.equal(turn.sessionId, hubSessionId);

    const lines = turn.command.split('\n');
    assert.equal(lines.length, 2);
    // Newest last: 5a1082be first, 1b2c3d4e second
    assert.equal(lines[0], '[tjob] 5a1082be TSGE speed T3: done, waiting for review');
    assert.equal(lines[1], '[tjob] 1b2c3d4e Fix typo: waiting, turn ended without tjob done');

    runtime.finish(hubSessionId);
    service.stop();
  });
});

test('does not interrupt hub while busy, delivers after it becomes idle', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, hubSessionId, userId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service.start();

    // 1. Simulate hub has an active turn running
    chatRunRegistry.startRun({
      appSessionId: hubSessionId,
      provider: 'claude',
      providerSessionId: 'provider-hub-session',
      connection: null,
      userId,
    });
    assert.equal(chatRunRegistry.isProcessing(hubSessionId), true);

    appendHubEvent({
      jobId: 'job-busy',
      state: 'review',
      title: 'Pending review',
      reason: 'waiting for review',
    });

    // Debounce expires
    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 0, 'must NEVER interrupt a running turn of the hub session');

    // 2. Hub turn finishes, but person is typing in UI composer (draft saved within 60s)
    chatRunRegistry.completeRun(hubSessionId, { exitCode: 0, aborted: false });
    assert.equal(chatRunRegistry.isProcessing(hubSessionId), false);

    sessionDraftsDb.saveDraft(userId, hubSessionId, {
      text: 'Human typing something...',
      queuedMessage: null,
    });
    // Anchor draft timestamp to test mock clock
    getConnection().prepare('UPDATE session_drafts SET updated_at = ? WHERE draft_scope = ?').run(
      clock.now.toISOString(),
      hubSessionId,
    );

    await service.tick();
    assert.equal(runtime.turns.length, 0, 'must not interrupt while person was typing in last 60s');

    // 3. 70s later without typing (draft expired)
    clock.advance(70);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'wakes the hub once idle');
    assert.ok(runtime.turns[0].command.includes('job-busy'));

    runtime.finish(hubSessionId);
    service.stop();
  });
});

test('survives a restart: pending events are re-read from the events log offset', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, clock }) => {
    // Phase 1: Service 1 processes event 1
    const service1 = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service1.start();

    appendHubEvent({
      jobId: 'job-1',
      state: 'review',
      title: 'First Job',
      reason: 'waiting for review',
    });

    clock.advance(100);
    await service1.tick();
    assert.equal(runtime.turns.length, 1);
    runtime.finish(config.hub!.sessionId);

    // Event 2 is appended right after, but NOT delivered before restart
    appendHubEvent({
      jobId: 'job-2',
      state: 'merged',
      title: 'Second Job',
      reason: 'sha-123 merged into main',
    });

    // Phase 2: Server restarts (service 1 stops, service 2 starts fresh)
    service1.stop();

    const service2 = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service2.start();

    // Debounce passes for service 2
    clock.advance(100);
    await service2.tick();

    assert.equal(runtime.turns.length, 2, 'second turn delivered after restart');
    const turn2 = runtime.turns[1];
    assert.ok(turn2.command.includes('job-2'), 'turn 2 includes unread event 2');
    assert.ok(!turn2.command.includes('job-1'), 'turn 2 does not repeat already-delivered event 1');

    service2.stop();
  });
});

test('no wake loop: hub wake turn does not generate events or trigger subsequent wakes', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, hubSessionId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service.start();

    appendHubEvent({
      jobId: 'normal-job',
      state: 'review',
      title: 'Normal job',
      reason: 'waiting for review',
    });

    clock.advance(100);
    await service.tick();
    assert.equal(runtime.turns.length, 1);

    // Even if an event with the hub session id was somehow written to log
    appendHubEvent({
      jobId: hubSessionId,
      state: 'turn_ended',
      title: 'Hub turn completed',
      reason: 'turn ended without tjob done',
    });

    // Complete the wake turn
    runtime.finish(hubSessionId);

    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'wake turn ending must not create a wake loop');
    service.stop();
  });
});

test('stall detection: emits stalled event when working job has no transcript activity for stallMin', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, clock }) => {
    config.hub!.stallMin = 10; // 10 minutes for testing
    config.hub!.debounceSec = 0; // immediate delivery for test

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service.start();

    const jobSessionId = 'agent-working-session';
    const transcriptPath = path.join(dir, 'agent-transcript.jsonl');
    writeFileSync(transcriptPath, 'line 1\n');
    utimesSync(transcriptPath, clock.now, clock.now);

    sessionsDb.createSession(
      jobSessionId,
      'claude',
      dir,
      'Job Agent',
      clock.now.toISOString(),
      clock.now.toISOString(),
      transcriptPath,
    );

    const job = orchestratorJobsDb.create({
      id: 'stall-job',
      title: 'Stalled Agent Job',
      prompt: 'Do work',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/stall-job',
      worktreePath: dir,
      requestedBackend: 'claude',
    });

    orchestratorJobsDb.update(job.id, {
      state: 'active',
      session_id: jobSessionId,
      in_turn: 1,
    });

    // Mark agent session as working in chatRunRegistry
    chatRunRegistry.startRun({
      appSessionId: jobSessionId,
      provider: 'claude',
      providerSessionId: 'provider-job',
      connection: null,
      userId: null,
    });

    // 5 minutes in: not stalled yet
    clock.advance(5 * 60);
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'not stalled yet at 5 minutes');

    // 11 minutes in: exceeds stallMin (10m)
    clock.advance(6 * 60);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'stall event delivered to hub');
    assert.ok(runtime.turns[0].command.includes('[tjob] stall-job Stalled Agent Job: stalled, no transcript activity for 10m'));

    // Another tick immediately after must NOT emit duplicate stall event
    await service.tick();
    assert.equal(runtime.turns.length, 1, 'does not duplicate stall event on subsequent ticks');

    runtime.finish(config.hub!.sessionId);
    service.stop();
  });
});

test('stall detection: zcode job with transcript being appended does not alarm even past 30m', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, clock }) => {
    config.hub!.stallMin = 30; // 30 minutes stall threshold
    config.hub!.debounceSec = 0; // immediate delivery for test

    const zcodeDir = path.join(dir, 'zcode');
    mkdirSync(zcodeDir, { recursive: true });

    const jobSessionId = 'zcode-active-session';
    const transcriptFile = path.join(zcodeDir, `${jobSessionId}.jsonl`);

    // Initial transcript write
    appendFileSync(transcriptFile, JSON.stringify({ event: 'user', content: 'Do work with GLM' }) + '\n');
    utimesSync(transcriptFile, clock.now, clock.now);

    // ZCode session has null jsonl_path in sessions table
    sessionsDb.createSession(
      jobSessionId,
      'zcode',
      dir,
      'Active GLM Agent',
      clock.now.toISOString(),
      clock.now.toISOString(),
      null,
    );

    const job = orchestratorJobsDb.create({
      id: 'zcode-active-job',
      title: 'Active GLM Job',
      prompt: 'Do work with GLM',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/zcode-active',
      worktreePath: dir,
      requestedBackend: 'zcode',
    });

    orchestratorJobsDb.update(job.id, {
      state: 'active',
      session_id: jobSessionId,
      in_turn: 1,
    });

    chatRunRegistry.startRun({
      appSessionId: jobSessionId,
      provider: 'zcode',
      providerSessionId: 'provider-active-job',
      connection: null,
      userId: null,
    });

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      zcodeTranscriptsDir: zcodeDir,
      isZcodeProcessAlive: () => true,
    });
    service.start();

    // 10 minutes in: fake zcode transcript being appended with a skipped event
    clock.advance(10 * 60);
    appendFileSync(transcriptFile, JSON.stringify({ event: 'error', content: 'ZCode Built-in skipped (not-due)\n' }) + '\n');
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'not stalled at 10 minutes');

    // 25 minutes in: stream delta appended
    clock.advance(15 * 60);
    appendFileSync(transcriptFile, JSON.stringify({ event: 'stream_delta', content: 'generating code...' }) + '\n');
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'not stalled at 25 minutes');

    // 40 minutes from start (exceeds 30m stallMin): another line appended
    clock.advance(15 * 60);
    appendFileSync(transcriptFile, JSON.stringify({ event: 'tool_use', toolName: 'RunCommand' }) + '\n');
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'no alarm at 40 minutes because transcript is actively appended');

    // 50 minutes from start: only 10m since last append, still active
    clock.advance(10 * 60);
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'no alarm at 50 minutes (only 10m elapsed since last activity)');

    runtime.finish(config.hub!.sessionId);
    service.stop();
  });
});

test('stall detection: zcode job with frozen transcript emits stalled event after 30 min', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, clock }) => {
    config.hub!.stallMin = 30; // 30 minutes stall threshold
    config.hub!.debounceSec = 0; // immediate delivery for test

    const zcodeDir = path.join(dir, 'zcode');
    mkdirSync(zcodeDir, { recursive: true });

    const jobSessionId = 'zcode-frozen-session';
    const transcriptFile = path.join(zcodeDir, `${jobSessionId}.jsonl`);

    // Initial transcript write at start
    appendFileSync(transcriptFile, JSON.stringify({ event: 'user', content: 'Frozen task' }) + '\n');
    utimesSync(transcriptFile, clock.now, clock.now);

    sessionsDb.createSession(
      jobSessionId,
      'zcode',
      dir,
      'Frozen GLM Agent',
      clock.now.toISOString(),
      clock.now.toISOString(),
      null,
    );

    const job = orchestratorJobsDb.create({
      id: 'zcode-frozen-job',
      title: 'Frozen GLM Job',
      prompt: 'Frozen work',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/zcode-frozen',
      worktreePath: dir,
      requestedBackend: 'zcode',
    });

    orchestratorJobsDb.update(job.id, {
      state: 'active',
      session_id: jobSessionId,
      in_turn: 1,
    });

    chatRunRegistry.startRun({
      appSessionId: jobSessionId,
      provider: 'zcode',
      providerSessionId: 'provider-frozen-job',
      connection: null,
      userId: null,
    });

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      zcodeTranscriptsDir: zcodeDir,
      isZcodeProcessAlive: () => true,
    });
    service.start();

    // Initial tick at 0m: not stalled
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'not stalled at start');

    // 15 minutes in: not stalled yet (15m < 30m)
    clock.advance(15 * 60);
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'not stalled yet at 15 minutes');

    // 31 minutes in: exceeds stallMin (30m) with transcript completely frozen
    clock.advance(16 * 60);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'stall event delivered to hub after 30m without transcript activity');
    assert.ok(runtime.turns[0].command.includes('[tjob] zcode-frozen-job Frozen GLM Job: stalled, no transcript activity for 30m'));

    // Another tick immediately after must NOT duplicate stall event
    await service.tick();
    assert.equal(runtime.turns.length, 1, 'does not duplicate stall event on subsequent ticks');

    runtime.finish(config.hub!.sessionId);
    service.stop();
  });
});

test('tjob hub-wake --test sends wake on demand', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });

    const res = await service.triggerTestWake();
    assert.equal(res.success, true);
    assert.equal(res.message, 'Test wake delivered to hub session.');

    assert.equal(runtime.turns.length, 1);
    assert.ok(runtime.turns[0].command.includes('[tjob] test wake: hub wake is active and responding'));
    runtime.finish(config.hub!.sessionId);
  });
});

test('deliverMessage handles turn rejection without unhandled rejection and retains pending events', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      runTurn: async () => {
        throw new Error('child process spawn error: simulated failure');
      },
    });
    service.start();

    appendHubEvent({
      jobId: 'job-rejection',
      state: 'review',
      title: 'Failed launch job',
      reason: 'waiting for review',
    });

    clock.advance(100);
    await service.tick();

    assert.equal(service.getPendingEvents().length, 1, 'pending event should be retained after delivery failure');
    assert.equal(service.getStoredOffset(), 0, 'offset should NOT be committed on delivery failure');
    service.stop();
  });
});

test('deliverMessage timeout returns false without unhandled rejection if runTurn rejects after timeout', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    let rejectLater!: (err: Error) => void;
    const hangingTurn = new Promise<{ started: boolean; error: string | null }>((_, reject) => {
      rejectLater = reject;
    });

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: () => hangingTurn,
    });
    service.start();

    appendHubEvent({
      jobId: 'job-late-rejection',
      state: 'review',
      title: 'Late rejection job',
      reason: 'waiting for review',
    });

    clock.advance(100);
    await service.tick();

    assert.equal(service.getPendingEvents().length, 1, 'pending event retained after timeout');
    assert.equal(service.getStoredOffset(), 0, 'offset not committed on timeout');

    // Turn rejects AFTER timeout has already returned false: must NOT crash process
    rejectLater(new Error('late provider explosion'));
    await new Promise((r) => setTimeout(r, 50));

    service.stop();
  });
});

test('serialized execution prevents race between readPendingEvents and wake dispatch (no lost events, no double delivery)', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    let onRunStarted: (() => void) | null = null;
    const trackingGateway = {
      ...runtime.gateway,
      run: (provider: string, command: string, options: Record<string, unknown>) => {
        const p = runtime.gateway.run(provider, command, options);
        onRunStarted?.();
        return p;
      },
    };

    const service = createHubWakeService({
      config: () => config,
      runtime: trackingGateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service.start();

    // Event 1 appended
    appendHubEvent({
      jobId: 'job-1',
      state: 'review',
      title: 'Event One',
      reason: 'waiting for review',
      timestamp: clock.now.toISOString(),
    });

    // Advance clock past debounce for Event 1
    clock.advance(100);

    const runStartedPromise = new Promise<void>((resolve) => {
      onRunStarted = resolve;
    });

    // Trigger tick - delivery begins
    const tick1 = service.tick();
    await runStartedPromise;

    // While turn 1 is executing in runtime, Event 2 arrives
    clock.advance(5);
    appendHubEvent({
      jobId: 'job-2',
      state: 'merged',
      title: 'Event Two',
      reason: 'merged into main',
      timestamp: clock.now.toISOString(),
    });

    // Complete turn 1
    runtime.finish(hubSessionId);
    await tick1;

    assert.equal(runtime.turns.length, 1);
    assert.ok(runtime.turns[0].command.includes('job-1'));
    assert.ok(!runtime.turns[0].command.includes('job-2'), 'first turn must only include event 1');

    // Debounce expires for Event 2
    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 2, 'second turn delivered with event 2');
    assert.ok(runtime.turns[1].command.includes('job-2'));
    assert.ok(!runtime.turns[1].command.includes('job-1'), 'second turn must not re-deliver event 1');
    runtime.finish(hubSessionId);

    service.stop();
  });
});

test('log truncation and rotation resets offsets and clears pendingEvents without missing subsequent writes', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service.start();

    appendHubEvent({
      jobId: 'job-pre-trunc',
      state: 'review',
      title: 'Pre-truncation job',
      reason: 'waiting for review',
      timestamp: clock.now.toISOString(),
    });

    clock.advance(100);
    await service.tick();
    assert.equal(runtime.turns.length, 1);
    runtime.finish(hubSessionId);
    assert.ok(service.getStoredOffset() > 0);

    // Truncate the file to 0 bytes (logrotate)
    writeFileSync(eventsLogPath, '', 'utf8');

    // Append new event to the truncated log
    appendHubEvent({
      jobId: 'job-post-trunc',
      state: 'turn_ended',
      title: 'Post-truncation job',
      reason: 'turn ended',
      timestamp: clock.now.toISOString(),
    });

    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 2, 'post-truncation event delivered');
    assert.ok(runtime.turns[1].command.includes('job-post-trunc'));
    assert.ok(!runtime.turns[1].command.includes('job-pre-trunc'));
    runtime.finish(hubSessionId);

    service.stop();
  });
});

test('persists and reconstructs stall-emission state across service restart (no duplicate stalls)', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    config.hub!.stallMin = 10;
    config.hub!.debounceSec = 0;

    const jobSessionId = 'stalled-restart-session';
    const transcriptPath = path.join(dir, 'transcript-restart.jsonl');
    writeFileSync(transcriptPath, 'line 1\n');
    utimesSync(transcriptPath, clock.now, clock.now);

    sessionsDb.createSession(
      jobSessionId,
      'claude',
      dir,
      'Restart Agent',
      clock.now.toISOString(),
      clock.now.toISOString(),
      transcriptPath,
    );

    const job = orchestratorJobsDb.create({
      id: 'stall-restart-job',
      title: 'Stall Restart Job',
      prompt: 'Do work',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/stall-restart',
      worktreePath: dir,
      requestedBackend: 'claude',
    });

    orchestratorJobsDb.update(job.id, {
      state: 'active',
      session_id: jobSessionId,
      in_turn: 1,
    });

    chatRunRegistry.startRun({
      appSessionId: jobSessionId,
      provider: 'claude',
      providerSessionId: 'provider-job',
      connection: null,
      userId: null,
    });

    // Service 1 starts
    const service1 = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service1.start();

    // 11 minutes in: exceeds stallMin (10m)
    clock.advance(11 * 60);
    await service1.tick();

    assert.equal(runtime.turns.length, 1, 'stall event delivered to hub');
    assert.ok(runtime.turns[0].command.includes('stall-restart-job'));
    runtime.finish(config.hub!.sessionId);

    // Stop Service 1 (simulating server restart)
    service1.stop();

    // Start Service 2 (fresh instance)
    const service2 = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service2.start();

    // Tick 3 seconds after restart: must NOT duplicate stall event
    clock.advance(3);
    await service2.tick();
    assert.equal(runtime.turns.length, 1, 'must NOT duplicate stall event after restart');

    // Now job has new transcript activity!
    clock.advance(60);
    writeFileSync(transcriptPath, 'line 2\n');
    utimesSync(transcriptPath, clock.now, clock.now);

    // 11 minutes after new activity: stalls again
    clock.advance(11 * 60);
    await service2.tick();
    assert.equal(runtime.turns.length, 2, 'emits new stall event after job has new activity and stalls again');
    runtime.finish(config.hub!.sessionId);

    service2.stop();
  });
});

test('stalled job becoming inactive is pruned from stall emission state preventing memory leak', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    config.hub!.stallMin = 5;
    config.hub!.debounceSec = 0;

    const jobSessionId = 'pruned-session';
    const transcriptPath = path.join(dir, 'transcript-pruned.jsonl');
    writeFileSync(transcriptPath, 'line 1\n');
    utimesSync(transcriptPath, clock.now, clock.now);

    sessionsDb.createSession(
      jobSessionId,
      'claude',
      dir,
      'Pruned Agent',
      clock.now.toISOString(),
      clock.now.toISOString(),
      transcriptPath,
    );

    const job = orchestratorJobsDb.create({
      id: 'job-to-prune',
      title: 'Pruned Job',
      prompt: 'Do work',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/pruned',
      worktreePath: dir,
      requestedBackend: 'claude',
    });

    orchestratorJobsDb.update(job.id, {
      state: 'active',
      session_id: jobSessionId,
      in_turn: 1,
    });

    chatRunRegistry.startRun({
      appSessionId: jobSessionId,
      provider: 'claude',
      providerSessionId: 'provider-pruned',
      connection: null,
      userId: null,
    });

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service.start();

    // Stall the job
    clock.advance(6 * 60);
    await service.tick();
    assert.ok(service.getLastStallEmitted(job.id) !== undefined, 'job has stall state');
    runtime.finish(config.hub!.sessionId);

    // Job transitions to 'done' (no longer active)
    orchestratorJobsDb.update(job.id, { state: 'done', in_turn: 0 });
    chatRunRegistry.completeRun(jobSessionId, { exitCode: 0, aborted: false });

    // Tick prunes the inactive job from lastStallEmitted
    await service.tick();
    assert.equal(service.getLastStallEmitted(job.id), undefined, 'inactive job pruned from stall state');

    service.stop();
  });
});

test('triggerWake distinguishes test vs non-test and enforces config validation', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });

    // 1. triggerWake({ test: false }) when no pending events
    const noEventsRes = await service.triggerWake({ test: false });
    assert.equal(noEventsRes.success, true);
    assert.equal(noEventsRes.message, 'No pending hub events to deliver.');
    assert.equal(runtime.turns.length, 0);

    // 2. triggerWake({ test: false }) with pending events
    appendHubEvent({
      jobId: 'job-manual',
      state: 'review',
      title: 'Manual wake job',
      reason: 'waiting for review',
    });
    const withEventsRes = await service.triggerWake({ test: false });
    assert.equal(withEventsRes.success, true);
    assert.equal(withEventsRes.message, 'Wake delivered to hub session.');
    assert.equal(runtime.turns.length, 1);
    assert.ok(runtime.turns[0].command.includes('job-manual'));
    runtime.finish(hubSessionId);

    // 3. triggerWake when hub.wake is undefined or false throws HUB_WAKE_DISABLED
    delete config.hub!.wake;
    await assert.rejects(
      async () => service.triggerWake({ test: false }),
      (err: any) => err.code === 'HUB_WAKE_DISABLED',
    );
  });
});

test('non-existent hub session does not wedge debounce timing or crash', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    config.hub!.sessionId = 'missing-session-xyz';
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service.start();

    appendHubEvent({
      jobId: 'job-orphan',
      state: 'review',
      title: 'Orphan job',
      reason: 'waiting for review',
    });

    clock.advance(100);
    // tick attempts delivery to non-existent session and safely backs off
    await service.tick();
    assert.equal(runtime.turns.length, 0);

    // Now restore session to real hub session
    config.hub!.sessionId = hubSessionId;
    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'turn delivered once session is available');
    assert.ok(runtime.turns[0].command.includes('job-orphan'));
    runtime.finish(hubSessionId);

    service.stop();
  });
});

/**
 * A runTurn that behaves like runDetachedChatTurn while the hub's previous
 * provider run is still settling: it stays undecided past the start timeout,
 * then reserves the session (onReserved) and starts once `release` is called.
 */
function createLateStartingTurns() {
  const contents: string[] = [];
  const gates: Array<(started: boolean) => void> = [];
  const runTurn = ((input: { content: string; onReserved?: () => void }) => {
    contents.push(input.content);
    return new Promise<{ started: boolean; error: string | null }>((resolve) => {
      gates.push((started) => {
        if (started) input.onReserved?.();
        resolve({ started, error: started ? null : 'A run is already in progress for this session.' });
      });
    });
  }) as unknown as NonNullable<Parameters<typeof createHubWakeService>[0]['runTurn']>;
  return {
    contents,
    runTurn,
    release(index: number, started = true) {
      gates[index](started);
    },
  };
}

const waitForTimers = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('a single logged event is delivered once over two wake cycles when the turn starts after the timeout', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    const turns = createLateStartingTurns();
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: turns.runTurn,
    });
    service.start();

    appendHubEvent({ jobId: 'hub-corpus', state: 'turn_ended', title: 'hub-detached turn', reason: 'clean exit' });

    clock.advance(100);
    await service.tick(); // wake cycle 1: the turn is still undecided at the timeout
    assert.equal(turns.contents.length, 1);

    clock.advance(5);
    await service.tick(); // still undecided: must not hand the event to a second turn
    assert.equal(turns.contents.length, 1, 'no second turn while the first may still start');

    turns.release(0); // the first turn starts late
    await waitForTimers();
    assert.equal(service.getStoredOffset(), readFileSync(eventsLogPath).length, 'late start commits the offset');
    assert.equal(service.getPendingEvents().length, 0);

    clock.advance(200);
    await service.tick(); // wake cycle 2
    assert.equal(turns.contents.length, 1, 'the event must not be delivered a second time');
    service.stop();
  });
});

test('an event logged during an in-flight wake is delivered once, without repeating the earlier one', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    const turns = createLateStartingTurns();
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: turns.runTurn,
    });
    service.start();

    appendHubEvent({ jobId: 'job-a', state: 'merged', title: 'Event A', reason: 'pushed e937275', timestamp: clock.now.toISOString() });
    clock.advance(100);
    await service.tick();
    assert.equal(turns.contents.length, 1);

    appendHubEvent({ jobId: 'job-b', state: 'review', title: 'Event B', reason: 'waiting for review', timestamp: clock.now.toISOString() });
    await waitForTimers();
    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 1, 'nothing is sent while the first wake is in flight');

    turns.release(0);
    await waitForTimers();
    assert.deepEqual(service.getPendingEvents().map((event) => event.jobId), ['job-b']);

    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 2);
    assert.ok(turns.contents[1].includes('job-b'));
    assert.ok(!turns.contents[1].includes('job-a'), 'event A must not be delivered again');
    turns.release(1);
    await waitForTimers();

    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 2, 'no further wakes');
    service.stop();
  });
});

test('a wake turn refused after the timeout keeps its events and delivers them once later', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    const turns = createLateStartingTurns();
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: turns.runTurn,
    });
    service.start();

    appendHubEvent({ jobId: 'job-refused', state: 'review', title: 'Refused', reason: 'waiting for review' });
    clock.advance(100);
    await service.tick();
    turns.release(0, false);
    await waitForTimers();
    assert.equal(service.getStoredOffset(), 0, 'a refused turn commits nothing');
    assert.equal(service.getPendingEvents().length, 1, 'a refused turn loses nothing');

    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 2);
    turns.release(1);
    await waitForTimers();
    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 2);
    service.stop();
  });
});

test('a restart after a late-starting wake does not deliver the event again (offset persisted at reservation)', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock }) => {
    const turns = createLateStartingTurns();
    const options = {
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: turns.runTurn,
    };
    const first = createHubWakeService(options);
    first.start();

    appendHubEvent({ jobId: 'job-restart', state: 'merged', title: 'Restart', reason: 'pushed' });
    clock.advance(100);
    await first.tick();
    turns.release(0);
    await waitForTimers();
    first.stop();

    assert.equal(readFileSync(offsetPath, 'utf8').trim(), String(readFileSync(eventsLogPath).length));

    const second = createHubWakeService(options);
    second.start();
    await waitForTimers();
    clock.advance(200);
    await second.tick();
    assert.equal(turns.contents.length, 1, 'the restarted service must not redeliver');
    assert.equal(second.getPendingEvents().length, 0);
    second.stop();
  });
});

test('a wake undecided past wakeAbandonMs releases its events; the next wake delivers them once and a late start drops nothing newer', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    config.hub = { ...config.hub!, wakeAbandonMs: 250 };
    const turns = createLateStartingTurns();
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn: turns.runTurn,
    });
    service.start();

    appendHubEvent({ jobId: 'job-stuck', state: 'review', title: 'Stuck', reason: 'waiting for review', timestamp: clock.now.toISOString() });
    clock.advance(100);
    await service.tick(); // wake A never decides
    assert.equal(turns.contents.length, 1);
    assert.equal(service.isHubBusy(hubSessionId), true, 'busy while wake A is within the bound');

    await waitForTimers(300); // past wakeAbandonMs
    assert.equal(service.isHubBusy(hubSessionId), false, 'abandoned wake releases the hub');
    assert.equal(service.getPendingEvents().length, 1, 'abandoned events are released, not lost');
    assert.equal(service.getStoredOffset(), 0);

    clock.advance(200);
    await service.tick(); // wake B redelivers
    assert.equal(turns.contents.length, 2);
    assert.ok(turns.contents[1].includes('job-stuck'));

    appendHubEvent({ jobId: 'job-newer', state: 'merged', title: 'Newer', reason: 'pushed', timestamp: clock.now.toISOString() });
    await waitForTimers();
    turns.release(0); // abandoned wake A starts late, while B is undecided
    await waitForTimers();
    assert.deepEqual(service.getPendingEvents().map((event) => event.jobId), ['job-newer'], 'late start keeps the newer event');
    assert.equal(service.isHubBusy(hubSessionId), true, 'A deciding late does not release wake B');

    turns.release(1);
    await waitForTimers();
    clock.advance(200);
    await service.tick();
    assert.equal(turns.contents.length, 3);
    assert.ok(turns.contents[2].includes('job-newer'));
    assert.ok(!turns.contents[2].includes('job-stuck'), 'the released event is delivered once by the next wake only');
    turns.release(2);
    await waitForTimers();
    assert.equal(service.getStoredOffset(), readFileSync(eventsLogPath).length);
    service.stop();
  });
});

test('under test, a wake never reaches the configured real hub: no live DB, no live events log', async () => {
  // Regression (2026-11-06): a test run delivered fixture events to the live hub session.
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    delete process.env.DATABASE_PATH;
    assert.match(String(hubWakeTestGuard({})), /DATABASE_PATH/);
    process.env.DATABASE_PATH = path.join(tmpdir(), 'hub-wake-guard.db');
    assert.match(String(hubWakeTestGuard({ eventsLogPath: getLiveHubEventsLogPath() })), /live hub events log/);
    assert.equal(hubWakeTestGuard({ eventsLogPath: path.join(tmpdir(), 'x.log') }), null);
    delete process.env.DATABASE_PATH;
    assert.equal(hubWakeTestGuard({ runTurn: (() => {}) as never }), null, 'an injected runTurn is a test sink');
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }

  // End to end: a hub wake built with the default chat path and no isolated DATABASE_PATH
  // (the live DB holds the real hub session) refuses delivery; nothing is dispatched.
  await withTestContext(async ({ config, runtime, clock, eventsLogPath, offsetPath, stallsPath }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    const isolatedDatabasePath = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;
    try {
      const result = await service.triggerWake({ test: true });
      assert.equal(result.success, false);
      assert.equal(runtime.turns.length, 0);
    } finally {
      process.env.DATABASE_PATH = isolatedDatabasePath;
    }
  });
});

test('stacked job wake: a base job sitting at review past 30m wakes the hub once for the queued job it holds', async () => {
  await withTestContext(async ({ dir, config, runtime, eventsLogPath, offsetPath, clock }) => {
    config.hub!.debounceSec = 0; // immediate delivery for test

    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
    });
    service.start();

    // The base job, done and at review; the stacked job, done and held at `queued` by the queue.
    const base = orchestratorJobsDb.create({
      id: 'basejob1',
      title: 'Base Job',
      prompt: 'p',
      repoPath: dir,
      baseBranch: 'main',
      branch: 'feature/base-job',
      worktreePath: dir,
      requestedBackend: 'glm',
    });
    orchestratorJobsDb.update(base.id, { state: 'done', merge_step: 'review' });
    const stacked = orchestratorJobsDb.create({
      id: 'stacked1',
      title: 'Stacked Job',
      prompt: 'p',
      repoPath: dir,
      baseBranch: base.branch,
      branch: 'feature/stacked-job',
      worktreePath: dir,
      requestedBackend: 'glm',
    });
    orchestratorJobsDb.update(stacked.id, { state: 'done', merge_step: 'queued' });

    // Fresh in review (10 minutes): nothing yet. (The clock moves in steps so it stays
    // past the wall-clock timestamps the events were written with.)
    clock.advance(10 * 60);
    await service.tick();
    assert.equal(runtime.turns.length, 0, 'no wake while the base is fresh in review');

    // The review has been sitting for 40 minutes (per the clock): one wake naming the wait.
    orchestratorJobsDb.recordMergeStep(base.id, 'review', new Date(clock.now.getTime() - 40 * 60_000).toISOString());
    clock.advance(30);
    await service.tick();
    assert.equal(runtime.turns.length, 1, 'one wake once the base sits at review past 30m');
    const line = runtime.turns[0].command.split('\n').find((entry) => entry.includes('stacked1'));
    assert.ok(line?.includes('stacked on base job basejob1'), `wake names the wait: ${line}`);

    // The same wait never fires twice; the dedupe state survives a restart.
    clock.advance(10 * 60);
    await service.tick();
    assert.equal(runtime.turns.length, 1, 'does not repeat the wake for the same wait');
    assert.ok(existsSync(`${eventsLogPath}.stacks.json`), 'the dedupe state is persisted');

    // A base still being worked on, or already merged, wakes nothing.
    orchestratorJobsDb.update(base.id, { merge_step: 'none' });
    clock.advance(30);
    await service.tick();
    assert.equal(runtime.turns.length, 1, 'no wake once the base leaves review');

    runtime.finish(config.hub!.sessionId);
    service.stop();
  });
});

test('a wake to a hub session that runs an agent carries provider, model and agent', async () => {
  // The hub may be an OpenCode session on Morph Kimi; a wake is a turn like
  // any other, so it runs with the hub session's model, effort and agent.
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, clock, hubSessionId }) => {
    sessionsDb.setSessionModel(hubSessionId, 'morph/morph-kimik31');
    sessionsDb.setSessionEffort(hubSessionId, 'low');
    sessionsDb.setSessionAgent(hubSessionId, 'morph-hub');
    const captured: Array<Record<string, unknown>> = [];
    const runTurn = (async (input: { options?: Record<string, unknown> }) => {
      captured.push(input.options ?? {});
      return { started: true, error: null };
    }) as unknown as NonNullable<Parameters<typeof createHubWakeService>[0]['runTurn']>;
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
      turnTimeoutMs: 20,
      runTurn,
    });
    service.start();

    appendHubEvent({ jobId: 'job-agent', state: 'merged', title: 'Agent Job', reason: 'pushed e937275' });
    clock.advance(100); // past the 90 s debounce
    await service.tick();

    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, 'morph/morph-kimik31');
    assert.equal(captured[0].effort, 'low');
    assert.equal(captured[0].agent, 'morph-hub');
    assert.equal(captured[0].permissionMode, 'bypassPermissions');
    service.stop();
  });
});

test('mixed events list decisions first and group review_fyi with merged as FYI in one wake', async () => {
  await withTestContext(async ({ config, runtime, eventsLogPath, offsetPath, stallsPath, hubSessionId, clock }) => {
    const service = createHubWakeService({
      config: () => config,
      runtime: runtime.gateway,
      now: () => clock.now,
      eventsLogPath,
      offsetPath,
      stallsPath,
    });
    service.start();

    appendHubEvent({ jobId: 'job-fyi', state: 'review_fyi', title: 'Low Risk', reason: 'auto-approved', timestamp: clock.now.toISOString() });
    appendHubEvent({ jobId: 'job-blocked', state: 'blocked', title: 'Needs Help', reason: 'rebase conflict', timestamp: clock.now.toISOString() });
    appendHubEvent({ jobId: 'job-merged', state: 'merged', title: 'Shipped', reason: 'pushed abc123', timestamp: clock.now.toISOString() });
    appendHubEvent({ jobId: 'job-review', state: 'review', title: 'Needs Review', reason: 'waiting for review', timestamp: clock.now.toISOString() });

    clock.advance(100);
    await service.tick();

    assert.equal(runtime.turns.length, 1, 'all mixed events share one wake message');
    assert.equal(runtime.turns[0].command, [
      'Decisions needed:',
      '[tjob] job-blocked Needs Help: blocked, rebase conflict',
      '[tjob] job-review Needs Review: done, waiting for review',
      '',
      'FYI — 2 events; no action needed:',
      '[tjob] job-fyi Low Risk: review passed, auto-approved',
      '[tjob] job-merged Shipped: merged, pushed abc123',
    ].join('\n'));

    runtime.finish(hubSessionId);
    service.stop();
  });
});

test('mixed wakes cap decisions before adding the FYI overflow', () => {
  const events: LoggedHubEvent[] = [
    ...Array.from({ length: 25 }, (_, index) => ({
      jobId: `decision-${index}`,
      state: 'review' as const,
      title: `Decision ${index}`,
      reason: 'needs review',
      timestamp: new Date(0).toISOString(),
    })),
    { jobId: 'fyi', state: 'review_fyi' as const, title: 'FYI', reason: 'auto-approved', timestamp: new Date(0).toISOString() },
  ];
  const message = buildHubWakeMessage(events);
  assert.equal(message.match(/\[tjob\]/g)?.length, 20);
  assert.match(message, /\+5 more decisions/);
  assert.match(message, /\+1 more FYI/);
  assert.doesNotMatch(message, /decision-20/);
});
