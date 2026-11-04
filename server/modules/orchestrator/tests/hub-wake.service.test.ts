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
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { appendHubEvent } from '../services/hub-events.service.js';
import { createHubWakeService } from '../services/hub-wake.service.js';
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
