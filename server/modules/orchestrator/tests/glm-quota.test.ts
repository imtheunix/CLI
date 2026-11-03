import assert from 'node:assert/strict';
import test from 'node:test';

import { detectGlmQuotaReset } from '../services/glm-quota.service.js';

// Exact message strings from local OpenCode APIErrors on 2026-11-02.
// Code 1308; no response headers/credentials are copied into fixtures.
for (const reset of ['2026-11-02 06:16:17', '2026-11-02 22:03:47']) {
  test(`detects observed Z.ai 5h limit resetting at ${reset}`, () => {
    const message = `Usage limit reached for 5 hour. Your limit will reset at ${reset}`;
    assert.equal(detectGlmQuotaReset(message, new Date('2026-11-01T19:35:50Z'))?.toISOString(), new Date(reset.replace(' ', 'T') + '+08:00').toISOString());
  });
}

test('missing, invalid or expired reset gets a one-hour cooldown; explicit offsets are respected', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  for (const suffix of ['', ' Your limit will reset at invalid', ' Your limit will reset at 2026-11-02 06:16:17']) {
    assert.equal(detectGlmQuotaReset('Usage limit reached for 5 hour.' + suffix, now)?.toISOString(), '2026-11-03T13:00:00.000Z');
  }
  assert.equal(detectGlmQuotaReset('Usage limit reached for 5 hour. Your limit will reset at 2026-11-03T15:00:00Z', now)?.toISOString(), '2026-11-03T15:00:00.000Z');
});

test('ordinary rate limits, errors and prompts do not identify quota exhaustion', () => {
  for (const text of ['429 Too Many Requests', 'Rate limit reached', 'Connection failed', 'Please handle quota', '']) {
    assert.equal(detectGlmQuotaReset(text, new Date()), null);
  }
});
