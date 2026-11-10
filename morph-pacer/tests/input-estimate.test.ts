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
