import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';

import { onHubEvent } from '../services/hub-events.service.js';
import type { LoggedHubEvent } from '../services/hub-wake.service.js';
import { parseHubEventLine } from '../services/hub-wake.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { RefuteService, RefuteVerdict } from '../services/refute.service.js';
import { briefPaths, createReviewService, evaluateReviewRisk, selectReviewTier } from '../services/review.service.js';
import { revParse } from '../services/workspace.service.js';
import type { CommandResult } from '../services/workspace.service.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

async function makeJob(root: string): Promise<OrchestratorJobRow> {
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
  git(repo, 'checkout', '-q', '-b', 'feature/review-test');
  await writeFile(path.join(repo, 'change.txt'), 'change\n');
  git(repo, 'add', 'change.txt');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change');
  return orchestratorJobsDb.create({
    id: 'review01',
    title: 'Review pipeline',
    prompt: 'Change src/allowed.ts only.',
    repoPath: repo,
    baseBranch: 'main',
    requestedBackend: 'claude',
    branch: 'feature/review-test',
    worktreePath: repo,
  });
}

type Fixture = {
  job: OrchestratorJobRow;
  config: OrchestratorConfig;
  events: LoggedHubEvent[];
  approvals: string[];
  fixes: string[];
  setBusy: (busy: boolean) => void;
  setDiff: (files: string[], lines?: number, stat?: string) => void;
  setPatch: (patch: string) => void;
  service: (verdicts: RefuteVerdict[], gateResults?: Array<{ ok: boolean; output?: string }>) => {
    tick: () => Promise<void>;
    refuteCalls: Array<{ backend: string; sessionId: string | null }>;
    gateCalls: number;
  };
};

async function withFixture(runTest: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'review-pipeline-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const job = await makeJob(root);
  const head = await revParse(job.worktree_path, 'HEAD');
  const ready = orchestratorJobsDb.update(job.id, {
    backend: 'claude', state: 'done', merge_step: 'review', review_step: 'gate', review_head_sha: head,
  }) as OrchestratorJobRow;
  const config = loadOrchestratorConfig(path.join(root, 'missing.json'));
  config.checks = { demo: 'npm run typecheck && npm run lint' };
  const events: LoggedHubEvent[] = [];
  const unsubscribe = onHubEvent((event) => {
    const parsed = parseHubEventLine([event.timestamp, event.jobId, event.state, event.title, event.reason].join('\t'));
    if (parsed) events.push(parsed);
  });
  const approvals: string[] = [];
  const fixes: string[] = [];
  let busy = false;
  const jobs = {
    isSessionBusy: () => busy,
    async approve(id: string) {
      approvals.push(id);
      orchestratorJobsDb.update(id, { merge_step: 'queued', review_step: 'approved' });
    },
    async reopenWithMessage(current: OrchestratorJobRow, message: string) {
      fixes.push(message);
      orchestratorJobsDb.update(current.id, { state: 'active', merge_step: 'none' });
      return true;
    },
  };
  let files = ['src/allowed.ts'];
  let lines = 60;
  let stat = ' 1 file changed, 30 insertions(+), 30 deletions(-)';
  let patch = '';
  const fakeRun = async (command: string, args: string[]) => {
    assert.equal(command, 'git');
    assert.equal(args[0], 'diff');
    const result: CommandResult = { code: 0, stdout: '', stderr: '' };
    if (args[1] === '--name-only') result.stdout = `${files.join('\n')}\n`;
    else if (args[1] === '--numstat') result.stdout = files.map((file) => `${Math.floor(lines / 2)}\t${lines - Math.floor(lines / 2)}\t${file}`).join('\n');
    else if (args[1] === '--stat') result.stdout = stat;
    else if (args[1] === '--unified=0') result.stdout = patch;
    else assert.fail(`unexpected diff args ${args.join(' ')}`);
    return result;
  };
  try {
    await runTest({
      job: ready,
      config,
      events,
      approvals,
      fixes,
      setBusy: (nextBusy) => { busy = nextBusy; },
      setDiff: (nextFiles, nextLines = 60, nextStat = ' 1 file changed, 30 insertions(+), 30 deletions(-)') => {
        files = nextFiles;
        lines = nextLines;
        stat = nextStat;
      },
      setPatch: (nextPatch) => { patch = nextPatch; },
      service: (verdicts, gateResults = [{ ok: true }]) => {
        const refuteCalls: Array<{ backend: string; sessionId: string | null }> = [];
        let refuteIndex = 0;
        let gateCalls = 0;
        const refuteService: RefuteService = {
          abort: () => undefined,
          refute: async (_job, backend, sessionId, onSession) => {
            refuteCalls.push({ backend, sessionId });
            onSession(`refute-session-${refuteCalls.length}`);
            const verdict = verdicts[Math.min(refuteIndex, verdicts.length - 1)];
            refuteIndex += 1;
            if (!verdict) throw new Error('missing verdict fixture');
            return verdict;
          },
        };
        const service = createReviewService({
          jobs,
          config: () => config,
          refuteService,
          run: fakeRun,
          gate: async () => {
            const result = gateResults[Math.min(gateCalls, gateResults.length - 1)];
            gateCalls += 1;
            return { ok: result.ok, output: result.output ?? '', command: 'scoped checks', logPath: '/tmp/review-gate.log' };
          },
        });
        return { tick: () => service.tick(), refuteCalls, get gateCalls() { return gateCalls; } };
      },
    });
  } finally {
    unsubscribe();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const pass: RefuteVerdict = { verdict: 'pass', defects: [] };
const defects: RefuteVerdict = {
  verdict: 'defects',
  defects: [{ what: 'bad return', probe: 'npm test -- return.test.ts', output: 'expected 2, got 1' }],
};

test('review waits until the producer session has stopped using the worktree', async () => {
  await withFixture(async ({ job, service, setBusy }) => {
    const review = service([pass]);
    setBusy(true);
    await review.tick();
    assert.equal(review.gateCalls, 0);
    assert.equal(review.refuteCalls.length, 0);
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'gate');
    setBusy(false);
    await review.tick();
    assert.equal(review.gateCalls, 1);
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'refute');
  });
});

test('happy path runs gate, refute and policy, then takes the ordinary approve path', async () => {
  await withFixture(async ({ job, service, approvals, events }) => {
    const review = service([pass]);
    await review.tick();
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'refute');
    await review.tick();
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'policy');
    await review.tick();
    const finished = orchestratorJobsDb.get(job.id)!;
    assert.equal(finished.merge_step, 'queued');
    assert.equal(finished.review_step, 'approved');
    assert.equal(finished.review_verdict, 'pass');
    assert.equal(finished.review_risk, 'low');
    assert.deepEqual(approvals, [job.id]);
    assert.equal(review.gateCalls, 1);
    assert.equal(review.refuteCalls[0].backend, 'glm');
    assert.equal(events.at(-1)?.state, 'review_fyi');
    assert.match(events.at(-1)?.reason ?? '', /auto-approved/);
  });
});

test('risky diff needs the hub with verdict, gate and diff stat only', async () => {
  await withFixture(async ({ job, service, approvals, events, setDiff }) => {
    setDiff(['infra/deploy.sh', 'src/allowed.ts'], 12, ' 2 files changed, 12 insertions(+)');
    const review = service([pass]);
    await review.tick();
    await review.tick();
    await review.tick();
    const finished = orchestratorJobsDb.get(job.id)!;
    assert.equal(finished.merge_step, 'review');
    assert.equal(finished.review_step, 'hub');
    assert.equal(finished.review_risk, 'high');
    assert.equal(finished.review_tier, 'deep');
    assert.deepEqual(approvals, []);
    const event = events.at(-1)!;
    assert.equal(event.state, 'review');
    assert.match(event.reason, /gate green; refute pass/);
    assert.match(event.reason, /2 files changed, 12 insertions/);
    assert.doesNotMatch(event.reason, /SECRET_PATCH_SHOULD_NOT_APPEAR/);
  });
});

test('reproduced defects trigger one fix round, then gate and refute run once more', async () => {
  await withFixture(async ({ job, service, fixes, approvals }) => {
    const review = service([defects, pass]);
    await review.tick();
    await review.tick();
    const returned = orchestratorJobsDb.get(job.id)!;
    assert.equal(returned.state, 'active');
    assert.equal(returned.review_step, 'fix');
    assert.equal(returned.review_round, 1);
    assert.equal(returned.review_verdict, 'defects');
    assert.equal(fixes.length, 1);
    assert.match(fixes[0], /expected 2, got 1/);
    // This is the persisted shape markDone writes after the producer's fix.
    orchestratorJobsDb.update(job.id, {
      state: 'done', merge_step: 'review', review_step: 'gate', review_verdict: null,
      review_risk: null, review_head_sha: null, review_session_id: null,
    });
    await review.tick();
    await review.tick();
    await review.tick();
    assert.equal(review.gateCalls, 2);
    assert.equal(review.refuteCalls.length, 2);
    assert.equal(approvals.length, 1);
  });
});

test('a second red gate stops at the hub instead of opening another fix round', async () => {
  await withFixture(async ({ job, service, fixes, events }) => {
    const review = service([pass], [{ ok: false, output: Array.from({ length: 60 }, (_, i) => `failure-${i}`).join('\n') }]);
    await review.tick();
    assert.equal(fixes.length, 1);
    assert.doesNotMatch(fixes[0], /failure-0\nfailure-1\nfailure-2/);
    assert.match(fixes[0], /failure-59/);
    orchestratorJobsDb.update(job.id, {
      state: 'done', merge_step: 'review', review_step: 'gate', review_head_sha: null, review_session_id: null,
    });
    await review.tick();
    assert.equal(fixes.length, 1);
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'hub');
    assert.equal(events.at(-1)?.state, 'review');
  });
});

test('restart in refute resumes that persisted step without repeating the gate or taking a job slot', async () => {
  await withFixture(async ({ job, service }) => {
    // Simulate a process that persisted refute and then died before launching/awaiting its reviewer.
    const review = service([pass]);
    orchestratorJobsDb.update(job.id, { review_step: 'refute' });
    let release: (() => void) | null = null;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const refuteService: RefuteService = {
      abort: () => undefined,
      refute: async () => { await waiting; return pass; },
    };
    const restarted = createReviewService({
      jobs: {
        approve: async (id) => { orchestratorJobsDb.update(id, { merge_step: 'queued' }); },
        reopenWithMessage: async () => { throw new Error('not expected'); },
        isSessionBusy: () => false,
      },
      config: () => loadOrchestratorConfig(path.join(path.dirname(process.env.DATABASE_PATH!), 'missing.json')),
      refuteService,
      run: async () => ({ code: 0, stdout: 'src/allowed.ts\n', stderr: '' }),
      gate: async () => { throw new Error('gate repeated after restart'); },
    });
    void review; // the old service is intentionally discarded, like a process restart.
    const ticking = restarted.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(orchestratorJobsDb.listByState(['preparing', 'active']).length, 0);
    assert.equal(orchestratorJobsDb.list().length, 1, 'refutation creates no producer job row');
    release!();
    await ticking;
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'policy');
  });
});

test('policy path extraction and limits fail closed', async () => {
  await withFixture(async ({ job, config }) => {
    assert.deepEqual(briefPaths('Touch `src/a.ts` and server/modules/orchestrator; never ../secret.'), ['src/a.ts', 'server/modules/orchestrator']);
    assert.deepEqual(briefPaths('Work in src/ only.'), ['src/'], 'a directory keeps its trailing slash');
    const directoryJob = { ...job, prompt: 'Work in src/ only.' };
    assert.equal(evaluateReviewRisk(directoryJob, { files: ['src/nested/allowed.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'low');
    assert.equal(evaluateReviewRisk(directoryJob, { files: ['other/allowed.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'high');
    assert.match(evaluateReviewRisk({ ...job, prompt: 'Touch ../secret only.' }, { files: ['src/allowed.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).reasons.join(' '), /unsafe or ambiguous/);
    assert.match(evaluateReviewRisk({ ...job, prompt: 'Touch /etc/passwd only.' }, { files: ['src/allowed.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).reasons.join(' '), /unsafe or ambiguous/);
    assert.equal(evaluateReviewRisk(job, { files: ['src/allowed.ts'], lines: 399, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'low');
    assert.equal(evaluateReviewRisk(job, { files: ['src/allowed.ts'], lines: 400, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'high');
    assert.equal(evaluateReviewRisk(job, { files: ['src/other.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'high');
    config.review.protectedRepos = ['demo'];
    assert.equal(evaluateReviewRisk(job, { files: ['src/allowed.ts'], lines: 1, stat: '', hasBinary: false, patch: '' }, config.review).risk, 'high');
  });
});

test('tier selection: docs-only, tests-only, small diff, risky path, protected repo, deep path and config writer', async () => {
  await withFixture(async ({ job, config }) => {
    const diff = (files: string[], lines = 10, patch = '') => ({ files, lines, stat: '', hasBinary: false, patch });
    assert.equal(selectReviewTier(job, diff(['docs/guide.md']), config.review).tier, 'gate');
    assert.equal(selectReviewTier(job, diff(['README.md']), config.review).tier, 'gate');
    assert.equal(selectReviewTier(job, diff(['server/modules/x/tests/a.test.ts']), config.review).tier, 'gate');
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 49), config.review).tier, 'gate');
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 50), config.review).tier, 'refute');
    assert.equal(selectReviewTier(job, diff(['infra/deploy.sh'], 1), config.review).tier, 'deep');
    config.review.protectedRepos = ['demo'];
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 1), config.review).tier, 'deep');
    config.review.protectedRepos = [];
    config.review.deepPaths = ['crates/kernel/'];
    assert.equal(selectReviewTier(job, diff(['crates/kernel/src/lib.rs'], 1), config.review).tier, 'deep');
    config.review.deepPaths = [];
    const writer = '+  writeFileSync(path.join(os.homedir(), ".config/cli/settings.json"), data);';
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 1, writer), config.review).tier, 'deep');
    const joined = "+  writeFileSync(path.join(os.homedir(), '.config', 'cli', 'settings.json'), data);";
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 1, joined), config.review).tier, 'deep');
    assert.equal(selectReviewTier(job, diff(['src/a.ts'], 1, '+  writeFileSync("out.txt", data);'), config.review).tier, 'gate');
  });
});

test('gate tier runs the gate and policy without a refutation', async () => {
  await withFixture(async ({ job, service, approvals, setDiff }) => {
    setDiff(['src/allowed.ts'], 5);
    const review = service([pass]);
    await review.tick();
    assert.equal(orchestratorJobsDb.get(job.id)?.review_tier, 'gate');
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'policy');
    await review.tick();
    assert.equal(review.refuteCalls.length, 0);
    assert.deepEqual(approvals, [job.id]);
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'approved');
  });
});

test('deep tier always goes to the hub after a passing refutation', async () => {
  await withFixture(async ({ job, service, approvals, events, setDiff }) => {
    setDiff(['infra/deploy.sh'], 5);
    const review = service([pass]);
    await review.tick();
    assert.equal(orchestratorJobsDb.get(job.id)?.review_tier, 'deep');
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'refute');
    await review.tick();
    await review.tick();
    assert.equal(orchestratorJobsDb.get(job.id)?.review_step, 'hub');
    assert.deepEqual(approvals, []);
    assert.match(events.at(-1)?.reason ?? '', /deep tier/);
  });
});
