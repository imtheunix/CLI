import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const tjobScript = path.join(applicationRoot, 'scripts', 'tjob');

type TjobResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs the real `scripts/tjob` against a fake curl, so the test covers the
 * script's own exit status rather than a mocked API client.
 */
function runTjob(args: string[], options: { body?: string; curlExit?: number } = {}): TjobResult {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tjob-cli-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    mkdirSync(path.join(home, '.cloudcli'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(home, '.cloudcli', 'local-server.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }));
    writeFileSync(path.join(home, '.cloudcli', 'orchestrator.token'), 'test-token\n');
    const fakeCurl = path.join(bin, 'curl');
    writeFileSync(
      fakeCurl,
      [
        '#!/usr/bin/env bash',
        'cat >/dev/null',
        'if [ -n "${TJBODY:-}" ]; then printf \'%s\' "$TJBODY"; fi',
        'if [ "${TJEXIT:-0}" -ne 0 ]; then echo "curl: (${TJEXIT}) fake transport failure" >&2; fi',
        'exit "${TJEXIT:-0}"',
        '',
      ].join('\n'),
    );
    chmodSync(fakeCurl, 0o755);

    const result = spawnSync('bash', [tjobScript, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TJBODY: options.body ?? '',
        TJEXIT: String(options.curlExit ?? 0),
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hubBody = JSON.stringify({
  success: true,
  data: { hub: { sessionId: 'sess-1', provider: 'opencode', model: 'morph/morph-kimik31', effort: 'low', agent: 'morph-hub', wake: true } },
});
const lsBody = JSON.stringify({ success: true, data: { loads: {}, caps: {}, jobs: [] } });
const apiFailureBody = JSON.stringify({ success: false, error: { message: 'boom' } });
const statusBody = JSON.stringify({
  success: true,
  data: {
    status: {
      at: '2026-11-10T12:00:00.000Z',
      needsYou: { goals: ['the restart'], jobs: [{ id: 'j6', title: 'Failed job', reason: 'boom' }] },
      goals: [{ title: 'Goal A', status: 'running', updated: '2026-11-10', now: 'doing A', next: 'do B', jobs: ['j1'], needs: 'the restart' }],
      jobs: {
        running: [{ id: 'j1', title: 'Running job', backend: 'morph', model: 'morph/morph-dsv41flash', state: 'active', mergeStep: 'none', ageMs: 7_200_000, waitingMs: null, step: null, at: null, reason: null }],
        review: [],
        queue: [],
        merged: [],
        failed: [{ id: 'j6', title: 'Failed job', backend: 'claude', model: 'claude-opus-5-5', state: 'failed', mergeStep: 'none', ageMs: null, waitingMs: null, step: null, at: '2026-11-10T11:00:00.000Z', reason: 'boom' }],
      },
      capacity: {
        morph: {
          source: 'ledger',
          groups: {
            kimi: { uncachedIn: 100, out: 10, caps: { uncachedIn: 72_870, out: 6_162 } },
            deepseek: { uncachedIn: 200, out: 20, caps: { uncachedIn: 2_103_237, out: 76_559 } },
          },
        },
        loads: { claude: 0, codex: 0, glm: 0, agy: 0, zcode: 0, morph: 1 },
        caps: { claude: 1, codex: 1, glm: 3, agy: 2, zcode: 3, morph: 2 },
        quota: { glm: null, zcode: null },
      },
      hub: { sessionId: 'hub-1', provider: 'opencode', model: 'morph/morph-kimik31', effort: 'medium', agent: 'morph-hub', lastWakeAt: '2026-11-10T11:55:00.000Z' },
      efficiency: {
        hour: {
          windowMs: 3_600_000,
          deepseek: { capUseAvg: 0.15, capUseP90: 0.2, activeMinutes: 2, slotOccupancy: 0.5 },
          kimi: { outputByRole: { hub: 150, planner: 300, jobs: 50, compaction: 100 }, reasoningShare: 0.316, cacheHit: 0.655, uncachedInputPerHubCall: 1_000 },
          flow: { leadTimeMedianMs: 7_200_000, reviewWaitMedianMs: 600_000, reviewWaitMaxMs: 600_000, fixRoundRate: 1, mergedPerHour: 1, tokensPerMergedJob: 5_000 },
          waste: { compactionTokens: 500, cancelledJobs: 1, pacerWaitMs: 1_000, retries429: 1 },
        },
        day: {
          windowMs: 86_400_000,
          deepseek: { capUseAvg: 0.26, capUseP90: 0.5, activeMinutes: 3, slotOccupancy: 0.06 },
          kimi: { outputByRole: { hub: 450, planner: 300, jobs: 50, compaction: 100 }, reasoningShare: 0.32, cacheHit: 0.49, uncachedInputPerHubCall: 1_500 },
          flow: { leadTimeMedianMs: 7_200_000, reviewWaitMedianMs: 600_000, reviewWaitMaxMs: 600_000, fixRoundRate: 1, mergedPerHour: 0.04, tokensPerMergedJob: 5_000 },
          waste: { compactionTokens: 500, cancelledJobs: 1, pacerWaitMs: 3_000, retries429: 3 },
        },
      },
    },
  },
});

test('tjob hub exits 0 on an HTTP 200 empty-body GET', () => {
  const result = runTjob(['hub'], { body: hubBody });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session: sess-1/);
});

test('tjob ls exits 0 on an HTTP 200 empty-body GET', () => {
  const result = runTjob(['ls'], { body: lsBody });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude: 0\/0/);
});

test('tjob status prints needs-you first, then goals, jobs, capacity, hub and efficiency', () => {
  const result = runTjob(['status'], { body: statusBody });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Needs you:/);
  assert.match(result.stdout, /the restart/);
  assert.match(result.stdout, /Goals:/);
  assert.match(result.stdout, /Goal A/);
  assert.match(result.stdout, /Jobs:/);
  assert.match(result.stdout, /Running job/);
  assert.match(result.stdout, /Capacity:/);
  assert.match(result.stdout, /Hub:/);
  assert.match(result.stdout, /Efficiency \(1h\):/);
  assert.match(result.stdout, /Efficiency \(24h\):/);
});

test('tjob status --md prints the markdown rendering', () => {
  const markdown = '# Status  (2026-11-10 12:00)\n\n## Needs you\n- the restart\n';
  const result = runTjob(['status', '--md'], { body: markdown });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, markdown);
});

test('tjob hub exits nonzero when the API reports failure', () => {
  const result = runTjob(['hub'], { body: apiFailureBody });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tjob: boom/);
});

test('tjob ls exits nonzero when the API reports failure', () => {
  const result = runTjob(['ls'], { body: apiFailureBody });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tjob: boom/);
});

test('tjob hub exits nonzero when the transport fails', () => {
  const result = runTjob(['hub'], { curlExit: 7 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake transport failure/);
});

test('tjob ls exits nonzero when the transport fails', () => {
  const result = runTjob(['ls'], { curlExit: 7 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake transport failure/);
});
