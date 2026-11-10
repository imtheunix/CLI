import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeOutputTokenRate,
  MIN_OUTPUT_RATE_WINDOW_MS,
  withOutputTokenRate,
} from '@/shared/token-rate.js';

test('a measured turn reports its output tokens per second', () => {
  assert.equal(computeOutputTokenRate(500, 1_000, 3_000), 250);
});

test('no output yet is unavailable, not zero', () => {
  assert.equal(computeOutputTokenRate(0, 1_000, 3_000), null);
  assert.equal(computeOutputTokenRate(-5, 1_000, 3_000), null);
});

test('a window shorter than the minimum is unavailable', () => {
  assert.equal(computeOutputTokenRate(10, 1_000, 1_000 + MIN_OUTPUT_RATE_WINDOW_MS - 1), null);
  assert.equal(computeOutputTokenRate(10, 1_000, 1_000 + MIN_OUTPUT_RATE_WINDOW_MS), 40);
});

test('a missing or non-finite start time is unavailable', () => {
  assert.equal(computeOutputTokenRate(100, null, 2_000), null);
  assert.equal(computeOutputTokenRate(100, undefined, 2_000), null);
  assert.equal(computeOutputTokenRate(100, Number.NaN, 2_000), null);
});

test('a cumulative counter is measured from the turn baseline, not the session lifetime', () => {
  // Codex reports a session-cumulative output count; the caller subtracts the
  // baseline it recorded when the turn started.
  const sessionCumulative = 9_000;
  const turnBaseline = 8_500;
  assert.equal(computeOutputTokenRate(sessionCumulative - turnBaseline, 10_000, 12_000), 250);
});

test('the budget keeps its cumulative usage and gains the rate only when measurable', () => {
  const budget = { used: 1_200, outputTokens: 200, total: 160_000 };
  assert.deepEqual(withOutputTokenRate(budget, 200, 1_000, 2_000), {
    ...budget,
    outputTokensPerSecond: 200,
  });
  assert.equal(withOutputTokenRate(budget, 0, 1_000, 2_000), budget);
  assert.equal(withOutputTokenRate(budget, 200, 1_000, 1_100), budget);
});
