import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';

const status = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { orchestrator: { status: () => status() } },
}));

const { default: StatusView } = await import('@/modules/status/StatusView');

const SNAPSHOT = {
  at: '2026-11-10T12:00:00.000Z',
  needsYou: { goals: ['the restart'], jobs: [{ id: 'j6', title: 'Failed job', reason: 'boom' }] },
  goals: [{ title: 'Goal A', status: 'running', updated: '2026-11-10', now: 'doing A', next: 'do B', jobs: ['j1'], needs: 'the restart' }],
  jobs: {
    running: [{ id: 'j1', title: 'Running job', backend: 'morph', model: 'morph/morph-dsv41flash', state: 'active', mergeStep: 'none', tier: null, ageMs: 7_200_000, waitingMs: null, step: null, at: null, reason: null }],
    review: [],
    queue: [],
    merged: [],
    failed: [{ id: 'j6', title: 'Failed job', backend: 'claude', model: 'claude-opus-5-5', state: 'failed', mergeStep: 'none', tier: null, ageMs: null, waitingMs: null, step: null, at: '2026-11-10T11:00:00.000Z', reason: 'boom' }],
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
      flow: { leadTimeMedianMs: 7_200_000, reviewWaitMedianMs: 600_000, reviewWaitMaxMs: 600_000, fixRoundRate: 1, reviewTiers: { gate: 0, refute: 1, deep: 0 }, mergedPerHour: 1, tokensPerMergedJob: 5_000 },
      waste: { compactionTokens: 500, cancelledJobs: 1, pacerWaitMs: 1_000, retries429: 1 },
    },
    day: {
      windowMs: 86_400_000,
      deepseek: { capUseAvg: 0.26, capUseP90: 0.5, activeMinutes: 3, slotOccupancy: 0.06 },
      kimi: { outputByRole: { hub: 450, planner: 300, jobs: 50, compaction: 100 }, reasoningShare: 0.32, cacheHit: 0.49, uncachedInputPerHubCall: 1_500 },
      flow: { leadTimeMedianMs: 7_200_000, reviewWaitMedianMs: 600_000, reviewWaitMaxMs: 600_000, fixRoundRate: 1, reviewTiers: { gate: 0, refute: 1, deep: 0 }, mergedPerHour: 0.04, tokensPerMergedJob: 5_000 },
      waste: { compactionTokens: 500, cancelledJobs: 1, pacerWaitMs: 3_000, retries429: 3 },
    },
  },
};

const response = () => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { status: SNAPSHOT } }),
});

beforeEach(() => {
  status.mockReset();
  status.mockImplementation(response);
});

afterEach(() => {
  vi.useRealTimers();
});

test('the Status view renders needs-you, goals, jobs, capacity, hub and efficiency', async () => {
  render(<StatusView />);
  await waitFor(() => assert.ok(screen.getByText('Needs you')));
  assert.ok(screen.getByText('the restart'));
  assert.ok(screen.getByText('Goal A'));
  assert.ok(screen.getByText('Running job'));
  assert.ok(screen.getByText('Failed job'));
  assert.ok(screen.getByText('Capacity'));
  assert.ok(screen.getByText('Hub'));
  assert.ok(screen.getByText('Efficiency (1h)'));
  assert.ok(screen.getByText('Efficiency (24h)'));
});

test('the Status view refreshes every 30 s', async () => {
  vi.useFakeTimers();
  render(<StatusView />);
  await act(async () => { await Promise.resolve(); });
  assert.equal(status.mock.calls.length, 1);
  await act(async () => {
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
  });
  assert.equal(status.mock.calls.length, 2);
});
