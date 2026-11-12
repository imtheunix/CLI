import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';
import { closeConnection, initializeDatabase, orchestratorJobsDb, userDb } from '@/modules/database/index.js';
import {
  isZcodeProbeHealthy,
  probeZcodeLogin,
  recordZcodeSuccess,
  resetZcodeProbeCache,
} from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { onHubEvent } from '../services/hub-events.service.js';
import { createJobsService } from '../services/jobs.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';

type Turn = { sessionId: string; command: string; options: Record<string, unknown> };
type TurnWriter = { send: (msg: unknown) => void };

function createRuntime() {
  const turns: Turn[] = [];
  const open = new Map<string, () => void>();
  const writers = new Map<string, TurnWriter>();
  const runtime = {
    turns,
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  execFileSync('git', ['add', file], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function eventually(check: () => boolean, what: string, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function withFakeZcode(runTest: (ctx: {
  root: string;
  repo: string;
  jobs: ReturnType<typeof createJobsService>;
  runtime: ReturnType<typeof createRuntime>;
  job: (id: string) => OrchestratorJobRow;
  setMode: (mode: 'healthy' | 'login_failed' | 'timeout') => Promise<void>;
  probeLog: () => Promise<string[]>;
  clock: { now: () => Date; advance: (ms: number) => void };
  timeoutMs: number;
}) => Promise<void>, initialMode: 'healthy' | 'login_failed' | 'timeout' = 'healthy', probeTimeoutMs: number = 20_000) {
  resetZcodeProbeCache();
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousPath = process.env.PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLoginScript = process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-probe-test-'));

  // The probe is explicit, so it still runs the fake binary; NODE_ENV=test only
  // keeps prepareZcodeHome from running the real API-key login against the
  // developer's home (which would add seconds to every probe and time the test out).
  process.env.NODE_ENV = 'test';

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  // The probe's throwaway home links the real credentials; never run the real
  // API-key login from a test (it can be slow and is not what is under test).
  process.env.ZCODE_APIKEY_LOGIN_SCRIPT = path.join(root, 'no-login.cjs');
  await initializeDatabase();
  userDb.createUser('orchestrator', 'hash');

  const binDir = path.join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'zcode');
  const logPath = path.join(root, 'zcode-invocations.log');
  const modeFile = path.join(root, 'mode.txt');
  await writeFile(modeFile, initialMode);

  await writeFile(scriptPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() : 'healthy';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'version') {
  process.stdout.write('ZCode 0.17.1\\n');
  process.exit(0);
}
if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'login_failed') {
  process.stderr.write("[project-access-token] { family: 'zai', stage: 'resolve', code: 'project_token_login_failed' }\\n");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\\n');
  process.exit(0);
}
`, { mode: 0o755 });

  process.env.PATH = binDir + path.delimiter + (previousPath ?? '');

  const origin = path.join(root, 'origin.git');
  const workspaces = path.join(root, 'ws');
  const repo = path.join(workspaces, 'demo');
  await mkdir(workspaces, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  await writeFile(path.join(repo, 'app.txt'), 'start\n');
  commitFile(repo, 'app.txt', 'start\n', 'start');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');

  const config = loadOrchestratorConfig(path.join(root, 'none.json'));
  config.workspacesRoot = workspaces;
  config.worktreesRoot = path.join(workspaces, '.jobs');
  config.checks = { demo: 'true' };
  config.review.enabled = false;
  config.glmProvider = 'zcode';
  config.backends.glm.provider = 'zcode';
  config.backends.glm.model = 'GLM-5.3-Flash';

  let currentClockMs = Date.now();
  const clock = {
    now: () => new Date(currentClockMs),
    advance: (ms: number) => { currentClockMs += ms; },
  };

  const runtime = createRuntime();
  const jobs = createJobsService({
    runtime: runtime.gateway,
    config: () => config,
    now: clock.now,
    captureCheckpoint: async () => ({}),
    probeZcode: (opts) => probeZcodeLogin({ timeoutMs: probeTimeoutMs, now: clock.now(), explicit: true, ...opts }),
  });
  const unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));

  const setMode = async (mode: 'healthy' | 'login_failed' | 'timeout') => {
    await writeFile(modeFile, mode);
  };

  const probeLog = async () => {
    try {
      const content = await readFile(logPath, 'utf8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  try {
    await runTest({
      root,
      repo,
      jobs,
      runtime,
      job: (id) => orchestratorJobsDb.get(id) as OrchestratorJobRow,
      setMode,
      probeLog,
      clock,
      timeoutMs: probeTimeoutMs,
    });
  } finally {
    unsubscribe();
    chatRunRegistry.clearAll();
    await jobs.afterCheckpoints().catch(() => {});
    closeConnection();
    resetZcodeProbeCache();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousLoginScript === undefined) delete process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
    else process.env.ZCODE_APIKEY_LOGIN_SCRIPT = previousLoginScript;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}

test('fake zcode probe: healthy mode allows turn to start and caches healthy status for 10 minutes', async () => {
  await withFakeZcode(async ({ repo, jobs, runtime, job, probeLog, clock }) => {
    const created = await jobs.create({
      title: 'healthy zcode probe',
      prompt: 'do work',
      repoPath: repo,
      backend: 'glm',
      baseBranch: null,
    });

    await eventually(() => runtime.turns.length === 1, 'first turn started');
    assert.equal(runtime.turns.length, 1);

    const log1 = await probeLog();
    assert.equal(log1.length, 1);
    const args = JSON.parse(log1[0]);
    assert.deepEqual(args, ['-p', 'ok', '--output-format', 'stream-json', '--mode', 'plan']);

    assert.equal(isZcodeProbeHealthy(clock.now()), true);

    // Turn completes successfully
    runtime.finish(runtime.turns[0].sessionId, { exitCode: 0 });

    // Send a second turn within 10 minutes (at 5 minutes)
    clock.advance(5 * 60_000);
    await jobs.notify(job(created.id), 'continue with more work');
    await eventually(() => runtime.turns.length === 2, 'second turn started');

    // No second probe should have been executed because healthy probe was cached!
    const log2 = await probeLog();
    assert.equal(log2.length, 1, 'probe must not be called again within 10 min');

    // Advance clock past 10 minutes (at 11 minutes total)
    clock.advance(6 * 60_000);
    runtime.finish(runtime.turns[1].sessionId, { exitCode: 0 });

    // Send a third turn at 11 minutes (past successful turn TTL)
    clock.advance(11 * 60_000);
    await jobs.notify(job(created.id), 'turn after 10 min');
    await eventually(() => runtime.turns.length === 3, 'third turn started');

    // Probe should have executed again because cache expired
    const log3 = await probeLog();
    assert.equal(log3.length, 2, 'probe must run once cache expires after 10 min');
  }, 'healthy');
});

test('fake zcode probe: login_failed holds job as auth_required, starts no turn, fires one hub wake, and resumes when healthy', async () => {
  await withFakeZcode(async ({ repo, jobs, runtime, job, setMode, clock }) => {
    const events: string[] = [];
    const stopHub = onHubEvent((event) => {
      events.push(`${event.state}:${event.reason}`);
    });

    try {
      const created = await jobs.create({
        title: 'failing zcode login',
        prompt: 'do work',
        repoPath: repo,
        backend: 'glm',
        baseBranch: null,
      });

      // Wait until job is held in auth_required
      await eventually(() => job(created.id)?.failure_class === 'auth_required', 'job held in auth_required');

      // No turn should have started because login failed
      assert.equal(runtime.turns.length, 0);

      const jobRow = job(created.id);
      assert.equal(jobRow.failure_class, 'auth_required');
      assert.match(jobRow.last_error ?? '', /project_token_login_failed/);
      assert.deepEqual(jobs.get(created.id)?.limitWait, {
        failureClass: 'auth_required',
        resumesAt: null,
        waitsForHub: false,
      });

      // Exactly ONE hub-wake event for login needed
      const wakeEvents = events.filter((e) => e.startsWith('waiting:login needed'));
      assert.equal(wakeEvents.length, 1);

      // Advance clock by 5 min: not yet due, tick does not probe or resume
      clock.advance(5 * 60_000);
      await jobs.tick();
      assert.equal(runtime.turns.length, 0);
      assert.equal(events.filter((e) => e.startsWith('waiting:login needed')).length, 1);

      // Now switch fake binary to healthy
      await setMode('healthy');

      // Advance clock to 10 min: recovery is due to probe
      clock.advance(5 * 60_000);
      await jobs.tick();

      // The existing login probe passes and resumes the job!
      await eventually(() => runtime.turns.length === 1, 'job turn resumed after login fixed');
      assert.equal(runtime.turns[0].command, 'Continue where you left off.');

      // Hub wake events should still be exactly 1
      assert.equal(events.filter((e) => e.startsWith('waiting:login needed')).length, 1);
    } finally {
      stopHub();
    }
  }, 'login_failed');
});

test('fake zcode probe: timeout mode does not hang, does not hold in auth_required, and does not cache', async () => {
  // Use a 150 ms timeout for the probe so test runs swiftly
  await withFakeZcode(async ({ repo, jobs, runtime, job, clock }) => {
    // Direct probe check verifies timeout error
    const directProbe = await probeZcodeLogin({ timeoutMs: 100, now: clock.now(), explicit: true });
    assert.equal(directProbe.ok, false);
    if (!directProbe.ok) {
      assert.equal(directProbe.error, 'timeout');
      assert.match(directProbe.message, /timed out after 100ms/);
    }
    assert.equal(isZcodeProbeHealthy(clock.now()), false);

    // Job turn dispatch with timeout probe:
    // Does not treat timeout as login_failed, so it proceeds to start the turn
    const created = await jobs.create({
      title: 'timeout zcode probe',
      prompt: 'do work',
      repoPath: repo,
      backend: 'glm',
      baseBranch: null,
    });

    await eventually(() => runtime.turns.length === 1, 'turn started despite probe timeout');
    assert.equal(runtime.turns.length, 1);
    assert.equal(job(created.id).failure_class, null);
    assert.equal(isZcodeProbeHealthy(clock.now()), false, 'timeout probe must not be cached as healthy');
  }, 'timeout', 150);
});
