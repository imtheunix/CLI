import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TurnTokenRateTracker,
  withTokenRate,
} from '@/modules/providers/services/token-rate.service.js';

test('reports no rate for a zero or short generation window', () => {
  let now = 1_000;
  const tracker = new TurnTokenRateTracker(() => now);
  tracker.start();

  assert.equal(tracker.addOutputTokens(10), null);

  now += 100;
  assert.equal(tracker.addOutputTokens(10), null);
});

test('accumulates per-request output tokens over the turn (Claude)', () => {
  let now = 0;
  const tracker = new TurnTokenRateTracker(() => now);
  tracker.start();

  now = 1_000;
  const first = tracker.addOutputTokens(100);
  assert.ok(first);
  assert.equal(first.outputTokens, 100);
  assert.equal(first.outputTokensPerSecond, 100);

  now = 2_000;
  const second = tracker.addOutputTokens(50);
  assert.ok(second);
  assert.equal(second.outputTokens, 150);
  assert.equal(second.outputTokensPerSecond, 75);
});

test('uses the turn cumulative output count (Codex)', () => {
  let now = 0;
  const tracker = new TurnTokenRateTracker(() => now);
  tracker.start();

  now = 2_000;
  const rate = tracker.setCumulativeOutputTokens(200);
  assert.ok(rate);
  assert.equal(rate.outputTokens, 200);
  assert.equal(rate.outputTokensPerSecond, 100);
});

test('ignores non-finite and negative usage samples', () => {
  let now = 0;
  const tracker = new TurnTokenRateTracker(() => now);
  tracker.start();

  now = 1_000;
  assert.equal(tracker.addOutputTokens(Number.NaN), null);
  assert.equal(tracker.addOutputTokens(-5), null);
  assert.equal(tracker.setCumulativeOutputTokens(Number.POSITIVE_INFINITY), null);
});

test('reset starts a fresh turn after a stop or finalization', () => {
  let now = 0;
  const tracker = new TurnTokenRateTracker(() => now);
  tracker.start();

  now = 1_000;
  assert.ok(tracker.addOutputTokens(100));

  tracker.reset();
  now = 2_000;
  tracker.start();
  now = 3_000;
  const rate = tracker.addOutputTokens(50);
  assert.ok(rate);
  assert.equal(rate.outputTokens, 50);
  assert.equal(rate.outputTokensPerSecond, 50);
});

test('withTokenRate preserves the budget and marks liveness', () => {
  const budget = { used: 10, outputTokens: 5 };
  const rate = { outputTokensPerSecond: 12.5, outputTokens: 5, elapsedMs: 400 };

  assert.deepEqual(withTokenRate(budget, rate, true), {
    ...budget,
    rate: { ...rate, live: true },
  });
  assert.equal(withTokenRate(budget, null, true), budget);
});
