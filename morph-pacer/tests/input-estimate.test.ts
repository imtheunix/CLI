import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Pacer } from '../src/pacer.js';

const quiet = { info() {}, warn() {}, error() {} } as never;

// Regression: the hub's Kimi requests carry a ~100k-token context that is almost all cached.
// Estimating uncached input as body/4 put every request over the 72,870 cap (x0.95) even on an
// empty window, so each one waited the full maxWaitMs (120 s) before being forwarded.
test('an oversized request is admitted at once on an empty window', async () => {
  const clock = new FakeClock();
  const pacer = new Pacer(DEFAULT_CONFIG, clock, quiet);
  const admission = await pacer.admit('morph-kimik31', 400_000 * 4);
  assert.equal(admission.waitMs, 0);
});

test('cached context is discounted by the recent uncached share', async () => {
  const clock = new FakeClock();
  const pacer = new Pacer(DEFAULT_CONFIG, clock, quiet);
  const first = await pacer.admit('morph-kimik31', 1_000);
  pacer.complete(first, { promptTokens: 100_000, cachedTokens: 96_000, completionTokens: 200, reasoningTokens: 0 } as never);
  // 400 KB body ~ 100k tokens; recent share 4% -> ~4k uncached, well under the cap.
  assert.equal(pacer.estimateUncachedInput('morph-kimik31', 400_000), 4_000);
  const next = await pacer.admit('morph-kimik31', 400_000);
  assert.equal(next.waitMs, 0);
  assert.equal(next.reservedInput, 4_000);
});

// Morph admits a request whenever the window is under the cap, whatever its size, and answers the
// next one with 429 + Retry-After (measured 2026-11-10: two 122k-uncached Kimi requests served, the
// third got 429, Retry-After 21). The default 'morph' admission does the same instead of also
// counting in-flight reservations and this request's own estimate.
test('morph admission: concurrent requests go through while the window is under the cap', async () => {
  const clock = new FakeClock();
  const pacer = new Pacer({ ...DEFAULT_CONFIG, admission: 'morph' }, clock, quiet);
  const a = await pacer.admit('morph-kimik31', 400_000 * 4);
  const b = await pacer.admit('morph-kimik31', 400_000 * 4);
  assert.equal(a.waitMs, 0);
  assert.equal(b.waitMs, 0);
});

test('morph admission: waits once the recorded window is over the cap, until it decays', async () => {
  const clock = new FakeClock();
  const pacer = new Pacer({ ...DEFAULT_CONFIG, admission: 'morph', maxWaitMs: 120_000 }, clock, quiet);
  const first = await pacer.admit('morph-kimik31', 1_000);
  pacer.complete(first, { promptTokens: 100_000, cachedTokens: 0, completionTokens: 10, reasoningTokens: 0 });
  let admitted = false;
  const next = pacer.admit('morph-kimik31', 1_000).then((x) => { admitted = true; return x; });
  await new Promise((resolve) => setImmediate(resolve)); // let admit start at t=0 before time moves
  await clock.advance(30_000);
  assert.equal(admitted, false);
  await clock.advance(31_000);
  const got = await next;
  assert.ok(got.waitMs >= 60_000 && got.waitMs <= 61_000, `waited ${got.waitMs}`);
});
