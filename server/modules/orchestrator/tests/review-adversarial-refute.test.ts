// Adversarial probes for automatic review, including the bounded-lifecycle fix round.
// Evidence for docs/reports/automatic-review-refute-996d995b.md and the 2026-11-10 fix report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, orchestratorJobsDb, sessionsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { onHubEvent } from '../services/hub-events.service.js';
import { createEffectOutbox } from '../services/effect-outbox.service.js';
import { createJobsService } from '../services/jobs.service.js';
import type { LoggedHubEvent } from '../services/hub-wake.service.js';
import { parseHubEventLine } from '../services/hub-wake.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { RefuteService, RefuteVerdict } from '../services/refute.service.js';
import { createRefuteService, parseRefuteVerdict, selectRefuteBackend } from '../services/refute.service.js';
import { createReviewService } from '../services/review.service.js';
import { revParse } from '../services/workspace.service.js';
import type { CommandResult } from '../services/workspace.service.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

const pass: RefuteVerdict = { verdict: 'pass', defects: [] };
const defects: RefuteVerdict = {
  verdict: 'defects',
  defects: [{ what: 'bad return', probe: 'npm test -- return.test.ts', output: 'expected 2, got 1' }],
};

type HubEventSpy = { events: LoggedHubEvent[]; unsubscribe: () => void };

function spyHubEvents(): HubEventSpy {
  const events: LoggedHubEvent[] = [];
  const unsubscribe = onHubEvent((event) => {
    const parsed = parseHubEventLine([event.timestamp, event.jobId, event.state, event.title, event.reason].join('\t'));
    if (parsed) events.push(parsed);
  });
  return { events, unsubscribe };
}

/** The review pipeline fixture: fake jobs actions, fake git diff, injectable refutation behaviour. */
async function withReviewFixture(
  runTest: (ctx: {
    job: OrchestratorJobRow;
    config: OrchestratorConfig;
    hub: HubEventSpy;
    approvals: string[];
    fixes: string[];
    setDiff: (files: string[], lines?: number) => void;
    setReopenResult: (delivered: boolean, activateProducer?: boolean) => void;
    service: (
      refuteImpl: RefuteService['refute'],
      abortImpl?: NonNullable<RefuteService['abort']>,
    ) => { tick: () => Promise<void>; refuteCalls: number };
  }) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'review-refute-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const repo = path.join(root, 'demo');
  const origin = path.join(root, 'origin.git');
  await mkdir(repo, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature/refute-probe');
  await writeFile(path.join(repo, 'change.txt'), 'change\n');
  git(repo, 'add', 'change.txt');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change');
  const job = orchestratorJobsDb.create({
    id: 'refute01',
    title: 'Refute probe',
    prompt: 'Change src/allowed.ts only.',
    repoPath: repo,
    baseBranch: 'main',
    requestedBackend: 'claude',
    branch: 'feature/refute-probe',
    worktreePath: repo,
  });
  const head = await revParse(job.worktree_path, 'HEAD');
  const ready = orchestratorJobsDb.update(job.id, {
    backend: 'claude', state: 'done', merge_step: 'review', review_step: 'gate', review_head_sha: head,
  }) as OrchestratorJobRow;
  const config = loadOrchestratorConfig(path.join(root, 'missing.json'));
  config.checks = { demo: 'npm run typecheck && npm run lint' };
  const hub = spyHubEvents();
  const approvals: string[] = [];
  const fixes: string[] = [];
  let reopenDelivered = true;
  let activateProducer = true;
  const jobs = {
    isSessionBusy: () => false,
    async approve(id: string) {
      approvals.push(id);
      orchestratorJobsDb.update(id, { merge_step: 'queued', review_step: 'approved' });
    },
    async reopenWithMessage(current: OrchestratorJobRow, message: string) {
      fixes.push(message);
      if (activateProducer) orchestratorJobsDb.update(current.id, { state: 'active', merge_step: 'none' });
      return reopenDelivered;
    },
  };
  let files = ['src/allowed.ts'];
  let lines = 10;
  const fakeRun = async (_command: string, args: string[]): Promise<CommandResult> => {
    assert.equal(args[0], 'diff');
    const result: CommandResult = { code: 0, stdout: '', stderr: '' };
    if (args[1] === '--name-only') result.stdout = `${files.join('\n')}\n`;
    else if (args[1] === '--numstat') result.stdout = files.map((file) => `${Math.floor(lines / 2)}\t${lines - Math.floor(lines / 2)}\t${file}`).join('\n');
    else result.stdout = ' 1 file changed';
    return result;
  };
  try {
    await runTest({
      job: ready,
      config,
      hub,
      approvals,
      fixes,
      setDiff: (nextFiles, nextLines = 10) => { files = nextFiles; lines = nextLines; },
      setReopenResult: (delivered, activate = true) => { reopenDelivered = delivered; activateProducer = activate; },
      service: (refuteImpl, abortImpl) => {
        let refuteCalls = 0;
        const refuteService: RefuteService = {
          refute: (jobRow, backend, sessionId, onSession, options) => {
            refuteCalls += 1;
            onSession(`refute-session-${refuteCalls}`);
            return refuteImpl(jobRow, backend, sessionId, onSession, options);
          },
          abort: abortImpl ?? (() => undefined),
        };
        const review = createReviewService({ jobs, config: () => config, refuteService, run: fakeRun, gate: async () => ({ ok: true, output: '', command: 'scoped', logPath: '/tmp/gate.log' }) });
        return { tick: () => review.tick(), get refuteCalls() { return refuteCalls; } };
      },
    });
  } finally {
    hub.unsubscribe();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('probe: a refutation parked past a duplicate tick launches exactly once, and a DB restart resumes it once', async () => {
  await withReviewFixture(async ({ job, service, approvals }) => {
    let release: (() => void) | null = null;
    const parked = new Promise<RefuteVerdict>((resolve) => { release = () => resolve(pass); });
    const review = service(() => parked);
    await review.tick(); // pass 1: gate green -> review_step refute
    const parkedTick = review.tick(); // pass 2: the refutation starts and parks
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Duplicate tick while the refutation is in flight: inFlight suppresses a second launch.
    await review.tick();
    assert.equal(review.refuteCalls, 1, 'no duplicate refutation for one producer completion');
    release!();
    await parkedTick;
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'policy');
    await review.tick();
    assert.equal(approvals.length, 1);
    assert.equal(review.refuteCalls, 1, 'policy consumes no second refutation');

    // A restart re-enters the persisted step; the refutation is not repeated for the same completion.
    closeConnection();
    await initializeDatabase();
    let resumed = 0;
    const restarted = service(async () => { resumed += 1; return pass; });
    await restarted.tick();
    assert.equal(resumed, 0, 'an approved review is not re-refuted after restart');
  });
});

test('probe: a manual approve during a parked refutation wins and the review result is discarded', async () => {
  await withReviewFixture(async ({ job, service, approvals, hub }) => {
    orchestratorJobsDb.update(job.id, { review_step: 'refute' });
    let release: (() => void) | null = null;
    const parked = new Promise<RefuteVerdict>((resolve) => { release = () => resolve(pass); });
    const review = service(() => parked);
    const ticking = review.tick(); // parks inside the refutation
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The hub approves while the refutation is running (concurrent approve).
    approvals.push(job.id);
    orchestratorJobsDb.update(job.id, { merge_step: 'queued', review_step: 'approved' });
    release!();
    await ticking;
    assert.deepEqual(approvals, [job.id], 'the automatic path adds no second approval');
    assert.equal(orchestratorJobsDb.get(job.id)?.merge_step, 'queued');
    assert.equal(hub.events.length, 0, 'no review decision or FYI is emitted after a manual approval');
  });
});

test('probe: a cancel during a parked refutation sticks; the review neither approves nor wakes the hub', async () => {
  await withReviewFixture(async ({ job, service, approvals, hub }) => {
    orchestratorJobsDb.update(job.id, { review_step: 'refute' });
    let release: (() => void) | null = null;
    const parked = new Promise<RefuteVerdict>((resolve) => { release = () => resolve(pass); });
    const review = service(() => parked);
    const ticking = review.tick(); // parks inside the refutation
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The person cancels while the refutation is running (concurrent cancel).
    orchestratorJobsDb.update(job.id, { state: 'cancelled', merge_step: 'none' });
    release!();
    await ticking;
    const cancelled = orchestratorJobsDb.get(job.id)!;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.merge_step, 'none');
    assert.deepEqual(approvals, [], 'a cancelled job is never auto-approved');
    assert.equal(hub.events.length, 0);
  });
});

test('probe: a crashing refutation escalates to the hub exactly once, never approves, and stays out of a retry loop', async () => {
  await withReviewFixture(async ({ job, service, approvals, hub, fixes }) => {
    orchestratorJobsDb.update(job.id, { review_step: 'refute' });
    const review = service(async () => { throw new Error('Refutation backend login failed: no zcode login'); });
    await review.tick();
    const escalated = orchestratorJobsDb.get(job.id)!;
    assert.equal(escalated.review_step, 'hub');
    assert.equal(escalated.review_risk, 'high');
    assert.deepEqual(approvals, [], 'a failed refutation never approves');
    assert.deepEqual(fixes, [], 'a reviewer crash opens no fix round');
    const decisions = hub.events.filter((event) => event.state === 'review');
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].reason, /Refutation backend login failed/);
    // Further ticks do nothing: the escalation is terminal (no retry/review loop).
    await review.tick();
    await review.tick();
    assert.equal(review.refuteCalls, 1, 'the refutation is not retried after escalation');
    assert.equal(hub.events.length, 1);
  });
});

test('probe: defects on the second completion open no second fix round', async () => {
  await withReviewFixture(async ({ job, service, approvals, fixes, hub }) => {
    // Persisted shape after one fix round: review_round = 1, producer re-done at a new HEAD.
    orchestratorJobsDb.update(job.id, { review_step: 'refute', review_round: 1, review_head_sha: 'head2', review_session_id: 'old' });
    const review = service(async () => defects);
    await review.tick();
    const escalated = orchestratorJobsDb.get(job.id)!;
    assert.equal(escalated.review_step, 'hub');
    assert.equal(escalated.review_round, 1, 'the one fix round is preserved, not reset');
    assert.deepEqual(fixes, []);
    assert.deepEqual(approvals, []);
    assert.match(hub.events.at(-1)?.reason ?? '', /refutation found defects/);
    assert.match(hub.events.at(-1)?.reason ?? '', /expected 2, got 1/);
  });
});

test('probe: a busy producer refusing the fix reopen is restored to review and the hub receives the only fix evidence', async () => {
  await withReviewFixture(async ({ job, service, hub, approvals, fixes, setReopenResult }) => {
    setReopenResult(false, true); // reopenWithMessage activated the producer, then found it busy
    const review = service(async () => defects);
    await review.tick();
    await review.tick();
    const parked = orchestratorJobsDb.get(job.id)!;
    assert.equal(parked.state, 'done');
    assert.equal(parked.merge_step, 'review');
    assert.equal(parked.review_step, 'hub');
    assert.equal(parked.review_round, 1);
    assert.equal(fixes.length, 1, 'the sole automatic fix round was attempted once');
    assert.deepEqual(approvals, []);
    assert.match(hub.events.at(-1)?.reason ?? '', /did not receive the only automatic fix message/);
    assert.match(hub.events.at(-1)?.reason ?? '', /expected 2, got 1/);
    await review.tick();
    assert.equal(review.refuteCalls, 1);
    assert.equal(hub.events.length, 1);
  });
});

test('probe: an auth reopen refusal before activation cannot strand the job at fix or drop its defect evidence', async () => {
  await withReviewFixture(async ({ job, service, hub, approvals, setReopenResult }) => {
    setReopenResult(false, false); // refused before the producer state transition
    const review = service(async () => defects);
    await review.tick();
    await review.tick();
    const parked = orchestratorJobsDb.get(job.id)!;
    assert.equal(parked.state, 'done');
    assert.equal(parked.merge_step, 'review');
    assert.equal(parked.review_step, 'hub');
    assert.equal(parked.review_round, 1);
    assert.deepEqual(approvals, []);
    assert.match(hub.events.at(-1)?.reason ?? '', /session busy or authentication hold/);
    assert.match(hub.events.at(-1)?.reason ?? '', /bad return/);
  });
});

test('probe: a never-settling refutation is aborted, parked at the hub with its exact reason, and never retried', async () => {
  await withReviewFixture(async ({ job, config, service, hub, approvals }) => {
    orchestratorJobsDb.update(job.id, { review_step: 'refute' });
    config.review.refuteTimeoutMs = 25;
    const never = new Promise<RefuteVerdict>(() => undefined);
    const aborted: Array<{ jobId: string; sessionId: string | null | undefined }> = [];
    const review = service(() => never, (current, sessionId) => {
      aborted.push({ jobId: current.id, sessionId });
    });
    await review.tick();
    const parked = orchestratorJobsDb.get(job.id)!;
    assert.equal(parked.review_step, 'hub');
    assert.equal(parked.review_risk, 'high');
    assert.deepEqual(aborted, [{ jobId: job.id, sessionId: 'refute-session-1' }]);
    assert.deepEqual(approvals, []);
    assert.equal(hub.events.length, 1);
    assert.equal(
      hub.events[0].reason,
      'review needed: automatic refutation timed out after 25 ms; reviewer aborted and its session was archived; gate green',
    );
    // The timeout released inFlight, and hub is terminal rather than a retry loop.
    await review.tick();
    await review.tick();
    assert.equal(review.refuteCalls, 1);
    assert.equal(hub.events.length, 1);
    assert.deepEqual(approvals, []);
  });
});

test('probe: parseRefuteVerdict treats a failed provider run as a crash, not a verdict', () => {
  assert.throws(
    () => parseRefuteVerdict([{ kind: 'text', role: 'assistant', content: '{"verdict":"pass","defects":[]}' }, { kind: 'complete', exitCode: 1 }]),
    /exited with code 1/,
  );
  assert.throws(() => parseRefuteVerdict([{ kind: 'complete', exitCode: 0 }]), /no assistant response/);
  assert.equal(selectRefuteBackend({ backend: 'agy', requested_backend: 'agy' } as OrchestratorJobRow, { review: { refuteBackendFor: {} } } as OrchestratorConfig), 'glm');
});

test('probe: restart with an empty run registry reuses a completed refute session transcript without a second turn', async () => {
  await withReviewFixture(async ({ job, config }) => {
    const sessionId = 'terminal-refute-session';
    sessionsDb.createAppSession(sessionId, 'opencode', job.worktree_path, `Refute ${job.id}`);
    const current = orchestratorJobsDb.update(job.id, {
      review_step: 'refute', review_session_id: sessionId,
    }) as OrchestratorJobRow;
    let turnLaunches = 0;
    let historyReads = 0;
    const reviewer = createRefuteService({
      runtime: {
        hasRuntime: () => true, hasBackgroundWork: () => false, stopBackgroundTask: async () => false,
        resolveToolApproval: () => undefined, getPendingApprovalsForSession: () => [], abort: async () => true, run: async () => undefined,
      },
      config: () => config,
      readHistory: async (id) => {
        assert.equal(id, sessionId);
        historyReads += 1;
        return [
          { kind: 'text', role: 'user', content: 'read-only refutation prompt' },
          { kind: 'text', role: 'assistant', content: '{"verdict":"pass","defects":[]}' },
        ];
      },
      runTurn: async () => {
        turnLaunches += 1;
        return { started: true, error: null };
      },
    });
    // Simulate a process restart: no chatRunRegistry entry, only the durable provider transcript.
    assert.equal(chatRunRegistry.getRun(sessionId), undefined);
    const verdict = await reviewer.refute(current, 'glm', sessionId, (id) => {
      orchestratorJobsDb.update(job.id, { review_session_id: id });
    });
    assert.deepEqual(verdict, pass);
    assert.equal(historyReads, 1);
    assert.equal(turnLaunches, 0, 'a completed refute session is never prompted again after restart');
    assert.equal(orchestratorJobsDb.list().length, 1, 'recovery creates no producer job');
  });
});

// --- Real jobs service probes: duplicate done, cancel and approve guards on the review state ---

async function withJobsFixture(runTest: (ctx: {
  jobs: ReturnType<typeof createJobsService>;
  repo: string;
  config: OrchestratorConfig;
  newJob: (id: string) => Promise<OrchestratorJobRow>;
}) => Promise<void>, extraDeps: Partial<Parameters<typeof createJobsService>[0]> = {}): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'review-jobs-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const repo = path.join(root, 'demo');
  const origin = path.join(root, 'origin.git');
  mkdir(repo, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const config = loadOrchestratorConfig(path.join(root, 'none.json'));
  config.review.enabled = true;
  const jobs = createJobsService({
    runtime: {
      hasRuntime: () => true, hasBackgroundWork: () => false, stopBackgroundTask: async () => false,
      resolveToolApproval: () => undefined, getPendingApprovalsForSession: () => [], abort: async () => true, run: async () => undefined,
    },
    config: () => config,
    outbox: createEffectOutbox({}),
    probeZcode: async () => ({ ok: true }),
    ...extraDeps,
  });
  const newJob = async (id: string): Promise<OrchestratorJobRow> => {
    git(repo, 'checkout', '-q', '-B', `feature/${id.toLowerCase()}`);
    await writeFile(path.join(repo, `${id}.txt`), `${id}\n`);
    git(repo, 'add', `${id}.txt`);
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', id);
    orchestratorJobsDb.create({
      id,
      title: `Probe ${id}`,
      prompt: 'probe',
      repoPath: repo,
      baseBranch: 'main',
      requestedBackend: 'claude',
      branch: `feature/${id.toLowerCase()}`,
      worktreePath: repo,
    });
    return orchestratorJobsDb.update(id, { state: 'active', backend: 'claude' }) as OrchestratorJobRow;
  };
  try {
    await runTest({ jobs, repo, config, newJob });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('probe: duplicate tjob done on a reviewed completion is rejected and review fields reset exactly once', async () => {
  await withJobsFixture(async ({ jobs, newJob }) => {
    const job = await newJob('dup1');
    const done = await jobs.markDone(job.id);
    assert.equal(done.state, 'done');
    assert.equal(done.merge_step, 'review');
    assert.equal(done.review_step, 'gate');
    assert.equal(done.review_round, 0);
    // The producer retried `tjob done` (for example after a restart): rejected, review state untouched.
    await assert.rejects(jobs.markDone(job.id), /not active/);
    const after = orchestratorJobsDb.get(job.id)!;
    assert.equal(after.merge_step, 'review');
    assert.equal(after.review_step, 'gate');
    // And after the hub approved: a second done is still refused (queued is not blocked/merged).
    await jobs.approve(job.id);
    await assert.rejects(jobs.markDone(job.id), /not active/);
  });
});

test('probe: cancel and approve guard the review state both ways', async () => {
  await withJobsFixture(async ({ jobs, newJob }) => {
    const cancellable = await newJob('cx1');
    await jobs.markDone(cancellable.id);
    const cancelled = await jobs.cancel(cancellable.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.merge_step, 'none');
    await assert.rejects(jobs.approve(cancellable.id), /not waiting for review/, 'a cancelled review cannot be approved');

    const approvable = await newJob('ap1');
    await jobs.markDone(approvable.id);
    const approved = await jobs.approve(approvable.id);
    assert.equal(approved.merge_step, 'queued');
    assert.equal(approved.review_step, 'approved');
    await assert.rejects(jobs.approve(approvable.id), /not waiting for review/, 'no double approval');
    // The queue itself stays deployment-gated: a queued job can still be cancelled before its rebase starts.
    const pulledBack = await jobs.cancel(approvable.id);
    assert.equal(pulledBack.state, 'cancelled');
    assert.equal(pulledBack.merge_step, 'none');
  });
});

test('probe: cancel aborts the real reviewer run and archives its session; a late terminal event stays cancelled', async () => {
  chatRunRegistry.clearAll();
  const providerAborts: string[] = [];
  const runtime = {
    hasRuntime: () => true, hasBackgroundWork: () => false, stopBackgroundTask: async () => false,
    resolveToolApproval: () => undefined, getPendingApprovalsForSession: () => [],
    abort: async (_provider: string, sessionId: string) => { providerAborts.push(sessionId); return true; },
    run: async () => undefined,
  };
  let reviewer: RefuteService | null = null;
  try {
    await withJobsFixture(async ({ jobs, newJob, repo, config }) => {
      reviewer = createRefuteService({ runtime, config: () => config });
      const job = await newJob('cxref');
      await jobs.markDone(job.id);
      const sessionId = 'cancel-refute-session';
      sessionsDb.createAppSession(sessionId, 'claude', repo, `Refute ${job.id}`);
      orchestratorJobsDb.update(job.id, { review_step: 'refute', review_session_id: sessionId });
      const run = chatRunRegistry.startRun({
        appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null,
      });
      assert.ok(run);
      const cancelled = await jobs.cancel(job.id);
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.merge_step, 'none');
      assert.equal(run.abortController.signal.aborted, true);
      assert.equal(run.status, 'completed');
      assert.equal(run.events.at(-1)?.kind, 'complete');
      assert.equal(run.events.at(-1)?.aborted, true);
      assert.deepEqual(providerAborts, [sessionId]);
      assert.equal(sessionsDb.getSessionById(sessionId)?.isArchived, 1);
      // A duplicate provider completion cannot reopen or approve the discarded review.
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0 });
      assert.equal(orchestratorJobsDb.get(job.id)?.state, 'cancelled');
      assert.equal(orchestratorJobsDb.get(job.id)?.merge_step, 'none');
    }, {
      runtime,
      abortRefutation: (job) => reviewer?.abort(job),
    });
  } finally {
    chatRunRegistry.clearAll();
  }
});

// --- Migration idempotence and legacy rows ---

test('probe: review migrations are idempotent and legacy rows default to no review', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'review-migrations-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    // A legacy row written before automatic review existed.
    getConnection().exec(`INSERT INTO orchestrator_jobs (id, title, prompt, repo_path, base_branch, branch, worktree_path, requested_backend, state, merge_step, created_at, updated_at)
      VALUES ('legacy1', 'Legacy', 'p', '/tmp/r', 'main', 'feature/x', '/tmp/w', 'claude', 'done', 'review', '2026-01-01', '2026-01-01')`);
    // Re-running the whole init path (schema + migrations) must be idempotent.
    await initializeDatabase();
    await initializeDatabase();
    const columns = getConnection().prepare('PRAGMA table_info(orchestrator_jobs)').all() as Array<{ name: string }>;
    for (const column of ['review_step', 'review_verdict', 'review_risk', 'review_round', 'review_head_sha', 'review_session_id']) {
      assert.equal(columns.filter((entry) => entry.name === column).length, 1, `${column} added exactly once`);
    }
    const legacy = orchestratorJobsDb.get('legacy1')!;
    assert.equal(legacy.review_step, 'none');
    assert.equal(legacy.review_round, 0);
    assert.equal(legacy.review_verdict, null);
    // The row still round-trips review fields through the patchable columns.
    orchestratorJobsDb.update('legacy1', { review_step: 'gate', review_round: 2, review_verdict: 'pass' });
    const patched = orchestratorJobsDb.get('legacy1')!;
    assert.equal(patched.review_step, 'gate');
    assert.equal(patched.review_round, 2);
    assert.equal(patched.review_verdict, 'pass');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// --- Malformed orchestrator.json review sections ---

test('probe: malformed review config falls back to defaults and drops hostile values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-config-'));
  try {
    const write = async (content: string): Promise<string> => {
      const file = path.join(root, 'orchestrator.json');
      await writeFile(file, content);
      return file;
    };
    // A string review section is neither the legacy boolean nor an object: defaults survive.
    const stringSection = loadOrchestratorConfig(await write('{"review": "yes"}'));
    assert.equal(stringSection.review.enabled, true);
    assert.equal(stringSection.review.refuteCap, 2);
    assert.equal(stringSection.review.refuteTimeoutMs, 20 * 60_000);
    assert.equal(stringSection.review.maxLines, 400);
    // Hostile values: negatives, zero, wrong types, identity or unknown refuter mappings.
    const hostile = loadOrchestratorConfig(await write(JSON.stringify({
      review: {
        enabled: true,
        refuteCap: -3,
        refuteTimeoutMs: 31 * 60_000,
        maxLines: 0,
        riskyPaths: 'infra',
        protectedRepos: [42, null, 'demo', '  '],
        refuteBackendFor: { glm: 'glm', morph: 'nope', zcode: 'morph', claude: ['glm'] },
      },
    })));
    assert.equal(hostile.review.refuteCap, 2, 'a cap below 1 is dropped');
    assert.equal(hostile.review.refuteTimeoutMs, 20 * 60_000, 'a timeout above 20 minutes is dropped, so no run can approach 30 minutes');
    assert.equal(hostile.review.maxLines, 400, 'a maxLines below 1 is dropped');
    assert.deepEqual(hostile.review.riskyPaths, ['infra', 'auth', 'secrets', 'ci', 'migrations', 'k8s', '.forgejo', '.github'], 'a non-array riskyPaths is dropped');
    assert.deepEqual(hostile.review.protectedRepos, ['demo'], 'non-string entries are filtered');
    // The loader merges valid entries onto the defaults; unknown keys and non-backend values are dropped.
    assert.deepEqual(hostile.review.refuteBackendFor, {
      morph: 'glm', claude: 'glm', codex: 'glm', agy: 'glm',
      zcode: 'morph', // kept: a valid mapping
      glm: 'glm', // stored, but an identity mapping is bypassed at selection below
    }, 'unknown and non-backend refuters are dropped onto the defaults');
    const boundedOverride = loadOrchestratorConfig(await write('{"review":{"refuteTimeoutMs":25}}'));
    assert.equal(boundedOverride.review.refuteTimeoutMs, 25);
    // The legacy boolean still maps, both ways.
    assert.equal(loadOrchestratorConfig(await write('{"review": false}')).review.enabled, false);
    assert.equal(loadOrchestratorConfig(await write('{"review": true}')).review.enabled, true);
    // An array review section is ignored wholesale.
    assert.equal(loadOrchestratorConfig(await write('{"review": []}')).review.enabled, true);
    // The identity override cannot point a family at itself: the cross-family fallback holds.
    const identity = selectRefuteBackend({ backend: 'glm', requested_backend: 'glm' } as OrchestratorJobRow, hostile);
    assert.equal(identity, 'morph');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
