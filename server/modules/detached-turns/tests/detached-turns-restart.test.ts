import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  orchestratorJobsDb,
  runningTurnsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import {
  abortTurn,
  getTurnLogPath,
  getUnitExitCode,
  isSystemdRunAvailable,
  isTurnAlive,
  reattachActiveTurns,
  resetSystemdRunCache,
  spawnDetachedTurn,
} from '../index.js';

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

/** Set up scratch database, home, and turn directory for isolated test execution. */
async function withScratchEnvironment(
  runTest: (ctx: {
    root: string;
    turnsDir: string;
    createFakeAgent: (scriptContent: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'detached-turns-test-'));
  const turnsDir = path.join(root, 'turns');
  const prevDbPath = process.env.DATABASE_PATH;
  const prevTurnsDir = process.env.CLI_TURNS_DIR;

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'test.db');
  process.env.CLI_TURNS_DIR = turnsDir;

  await initializeDatabase();
  userDb.createUser('test-user', 'hash');

  const createFakeAgent = (scriptContent: string): string => {
    const agentPath = path.join(root, `fake-agent-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(agentPath, scriptContent, { mode: 0o755 });
    chmodSync(agentPath, 0o755);
    return agentPath;
  };

  try {
    await runTest({ root, turnsDir, createFakeAgent });
  } finally {
    closeConnection();
    if (prevDbPath) process.env.DATABASE_PATH = prevDbPath;
    else delete process.env.DATABASE_PATH;
    if (prevTurnsDir) process.env.CLI_TURNS_DIR = prevTurnsDir;
    else delete process.env.CLI_TURNS_DIR;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test('turn survives server disconnect and completes independently', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agentScript = createFakeAgent(`#!/usr/bin/env node
console.log(JSON.stringify({ kind: 'status', text: 'starting' }));
setTimeout(() => {
  console.log(JSON.stringify({ kind: 'stream_delta', content: 'hello from detached turn\\n' }));
}, 300);
setTimeout(() => {
  console.log(JSON.stringify({ kind: 'status', text: 'finished' }));
  process.exit(0);
}, 700);
`);

    const sessionId = 'session-survive-1';
    sessionsDb.createSession(sessionId, 'agy', root, 'Survive Turn Test');

    const execution = await spawnDetachedTurn({
      command: agentScript,
      args: [],
      cwd: root,
      sessionId,
      backend: 'agy',
    });

    const unitName = execution.unitName;
    assert.ok(unitName.startsWith('cli-turn-'));

    // Check that the unit is registered in DB as running
    const recorded = runningTurnsDb.getTurnByUnitName(unitName);
    assert.ok(recorded);
    assert.equal(recorded.session_id, sessionId);
    assert.equal(recorded.completed_at, null);

    // Verify it is alive
    assert.ok(await isTurnAlive(unitName));

    // Wait for the turn to complete on its own
    await execution.promise;

    assert.equal(await isTurnAlive(unitName), false);
    assert.equal(getUnitExitCode(unitName), 0);

    const logPath = getTurnLogPath(unitName);
    assert.ok(existsSync(logPath));
    const logContent = readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('hello from detached turn'));
  });
});

test('restart stops a cancelled job instead of reattaching its live turn', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agent = createFakeAgent('#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
    const sessionId = 'cancelled-session';
    sessionsDb.createSession(sessionId, 'agy', root, 'Cancelled');
    orchestratorJobsDb.create({ id: 'cancelled-job', title: 'Cancelled', prompt: 'work', repoPath: root,
      worktreePath: root, baseBranch: 'main', branch: 'feature/cancelled', requestedBackend: 'agy', model: null });
    orchestratorJobsDb.update('cancelled-job', { session_id: sessionId, state: 'cancelled' });
    const execution = await spawnDetachedTurn({ command: agent, args: [], cwd: root, sessionId, backend: 'agy', jobId: 'cancelled-job' });
    await eventually(() => isTurnAlive(execution.unitName), 'agent alive');
    await reattachActiveTurns();
    await execution.promise;
    assert.equal(orchestratorJobsDb.get('cancelled-job')?.state, 'cancelled');
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);
    assert.equal(await isTurnAlive(execution.unitName), false);
  });
});

test('reattach on startup resumes streaming and delivers output to subscriber', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agentScript = createFakeAgent(`#!/usr/bin/env node
console.log(JSON.stringify({ kind: 'status', text: 'turn-started' }));
setTimeout(() => {
  console.log(JSON.stringify({ kind: 'stream_delta', content: 'mid-flight output 1\\n' }));
}, 300);
setTimeout(() => {
  console.log(JSON.stringify({ kind: 'stream_delta', content: 'mid-flight output 2\\n' }));
}, 700);
setTimeout(() => {
  console.log(JSON.stringify({ kind: 'status', text: 'turn-complete' }));
  process.exit(0);
}, 1200);
`);

    const sessionId = 'session-reattach-stream';
    sessionsDb.createSession(sessionId, 'agy', root, 'Reattach Stream Test');

    // Start a turn
    const execution = await spawnDetachedTurn({
      command: agentScript,
      args: [],
      cwd: root,
      sessionId,
      backend: 'agy',
    });

    // Wait until the agent has started and is active
    await eventually(() => isTurnAlive(execution.unitName), 'turn alive');

    // Simulate server restart: clear memory runs and call reattachActiveTurns
    chatRunRegistry.clearAll();

    const receivedMessages: NormalizedMessage[] = [];
    const mockWriter = {
      isWebSocketWriter: true,
      send: (msg: unknown) => {
        receivedMessages.push(msg as NormalizedMessage);
      },
      updateWebSocket: () => {},
      sendComplete: () => {},
    };

    let completedReported = false;
    let completedExitCode = -1;

    // Call reattach with mock registry
    await reattachActiveTurns({
      chatRunRegistry: {
        startRun: () => ({ writer: mockWriter as never }),
        getRun: () => ({ writer: mockWriter as never }),
        completeRunIfCurrent: (_run, completion) => {
          completedReported = true;
          completedExitCode = completion.exitCode;
        },
      },
    });

    // Wait for the reattached stream to complete
    await eventually(() => completedReported, 'reattached turn completion', 5000);

    assert.equal(completedExitCode, 0);
    assert.ok(
      receivedMessages.some((msg) => typeof msg.content === 'string' && msg.content.includes('mid-flight output 1')),
      'subscriber received streamed output 1',
    );
    assert.ok(
      receivedMessages.some((msg) => typeof msg.content === 'string' && msg.content.includes('mid-flight output 2')),
      'subscriber received streamed output 2',
    );

    // Verify DB recorded completion
    const updated = runningTurnsDb.getTurnByUnitName(execution.unitName);
    assert.ok(updated);
    assert.equal(updated.exit_code, 0);
    assert.ok(updated.completed_at);
  });
});

test('a turn that finished while down is finalized on startup', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agentScript = createFakeAgent(`#!/usr/bin/env node
console.log(JSON.stringify({ kind: 'status', text: 'done-while-down' }));
process.exit(0);
`);

    const sessionId = 'session-finished-down';
    sessionsDb.createSession(sessionId, 'agy', root, 'Finished Down Test');

    // Create an orchestrator job to verify orchestrator notification
    const jobId = 'job-down-1';
    orchestratorJobsDb.create({
      id: jobId,
      title: 'Job finished while server was down',
      prompt: 'Do work',
      repoPath: root,
      worktreePath: root,
      baseBranch: 'main',
      branch: 'feature/test-down',
      requestedBackend: 'agy',
      model: 'test-model',
    });
    orchestratorJobsDb.update(jobId, {
      backend: 'agy',
      session_id: sessionId,
      state: 'active',
      in_turn: 1,
    });

    const execution = await spawnDetachedTurn({
      command: agentScript,
      args: [],
      cwd: root,
      sessionId,
      backend: 'agy',
      jobId,
    });

    // Wait until it completely finishes on disk while "server is down"
    await execution.promise;
    assert.equal(await isTurnAlive(execution.unitName), false);

    // Turn is not yet marked completed in running_turns DB (simulating server was killed before reading completion)
    // We update DB directly to simulate interrupted state where exit wasn't caught
    runningTurnsDb.recordTurn({
      unitName: execution.unitName,
      jobId,
      sessionId,
      backend: 'agy',
      logPath: getTurnLogPath(execution.unitName),
    });

    let completedTurnId: string | null = null;
    let completedCode = -1;

    // Server starts up and runs reattachActiveTurns
    await reattachActiveTurns({
      onTurnCompleted: (turn, exitCode) => {
        completedTurnId = turn.job_id;
        completedCode = exitCode;
        if (turn.job_id) {
          orchestratorJobsDb.update(turn.job_id, {
            in_turn: 0,
            ...(exitCode !== 0 ? { last_error: `turn failed: ${exitCode}` } : {}),
          });
        }
      },
    });

    assert.equal(completedTurnId, jobId);
    assert.equal(completedCode, 0);

    const job = orchestratorJobsDb.get(jobId);
    assert.ok(job);
    assert.equal(job.in_turn, 0);

    const turnRow = runningTurnsDb.getTurnByUnitName(execution.unitName);
    assert.ok(turnRow);
    assert.equal(turnRow.exit_code, 0);
    assert.ok(turnRow.completed_at);
  });
});

test('a turn that failed while down is finalized with non-zero exit code', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agentScript = createFakeAgent(`#!/usr/bin/env node
console.error('Fatal crash inside agent');
process.exit(42);
`);

    const sessionId = 'session-failed-down';
    sessionsDb.createSession(sessionId, 'agy', root, 'Failed Down Test');
    const jobId = 'job-down-fail-1';
    orchestratorJobsDb.create({
      id: jobId,
      title: 'Job failed while down',
      prompt: 'Do work',
      repoPath: root,
      worktreePath: root,
      baseBranch: 'main',
      branch: 'feature/test-fail',
      requestedBackend: 'agy',
      model: 'test-model',
    });
    orchestratorJobsDb.update(jobId, {
      backend: 'agy',
      session_id: sessionId,
      state: 'active',
      in_turn: 1,
    });

    const execution = await spawnDetachedTurn({
      command: agentScript,
      args: [],
      cwd: root,
      sessionId,
      backend: 'agy',
      jobId,
    });

    await execution.promise;
    assert.equal(await isTurnAlive(execution.unitName), false);

    // Reset turn row to incomplete
    runningTurnsDb.recordTurn({
      unitName: execution.unitName,
      jobId,
      sessionId,
      backend: 'agy',
      logPath: getTurnLogPath(execution.unitName),
    });

    let completedCode = -1;
    await reattachActiveTurns({
      onTurnCompleted: (turn, exitCode) => {
        completedCode = exitCode;
      },
    });

    assert.notEqual(completedCode, 0);
    const turnRow = runningTurnsDb.getTurnByUnitName(execution.unitName);
    assert.ok(turnRow);
    assert.notEqual(turnRow.exit_code, 0);
  });
});

test('fallback path without systemd-run executes directly and streams output', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    process.env.CLI_DISABLE_SYSTEMD_RUN = '1';
    resetSystemdRunCache();

    try {
      assert.equal(isSystemdRunAvailable(), false);

      const agentScript = createFakeAgent(`#!/usr/bin/env node
console.log(JSON.stringify({ kind: 'status', text: 'direct-spawn-running' }));
console.log(JSON.stringify({ kind: 'stream_delta', content: 'direct-spawn output\\n' }));
process.exit(0);
`);

      const sessionId = 'session-fallback-1';
      sessionsDb.createSession(sessionId, 'agy', root, 'Fallback Test');

      const lines: string[] = [];
      const execution = await spawnDetachedTurn({
        command: agentScript,
        args: [],
        cwd: root,
        sessionId,
        backend: 'agy',
        onLine: (line) => lines.push(line),
      });

      assert.equal(execution.isSystemd, false);
      const { exitCode } = await execution.promise;
      assert.equal(exitCode, 0);

      assert.ok(lines.some((l) => l.includes('direct-spawn output')));
      const logContent = readFileSync(getTurnLogPath(execution.unitName), 'utf8');
      assert.ok(logContent.includes('direct-spawn output'));
    } finally {
      delete process.env.CLI_DISABLE_SYSTEMD_RUN;
      resetSystemdRunCache();
    }
  });
});

test('abortTurn cancels in-flight turn and records exit', async () => {
  await withScratchEnvironment(async ({ root, createFakeAgent }) => {
    const agentScript = createFakeAgent(`#!/usr/bin/env node
console.log('long running process...');
setInterval(() => {}, 1000);
`);

    const sessionId = 'session-abort-test';
    sessionsDb.createSession(sessionId, 'agy', root, 'Abort Test');

    const execution = await spawnDetachedTurn({
      command: agentScript,
      args: [],
      cwd: root,
      sessionId,
      backend: 'agy',
    });

    await eventually(() => isTurnAlive(execution.unitName), 'turn alive');

    const aborted = abortTurn(sessionId);
    assert.ok(aborted);

    await execution.promise;
    assert.equal(await isTurnAlive(execution.unitName), false);
  });
});
