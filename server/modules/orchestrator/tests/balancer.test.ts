import assert from 'node:assert/strict';
import test from 'node:test';

import { isInGlmPeakHours, pickBackend } from '@/modules/orchestrator/services/balancer.service.js';

const CAPS = { claude: 2, codex: 2, glm: 3 };

test('an unrequested job goes to the backend working on the fewest jobs, ties to the cheapest', () => {
  assert.equal(pickBackend(null, { claude: 0, codex: 0, glm: 0 }, CAPS, 'glm'), 'glm');
  assert.equal(pickBackend(null, { claude: 0, codex: 0, glm: 1 }, CAPS, 'glm'), 'codex');
  assert.equal(pickBackend(null, { claude: 0, codex: 1, glm: 1 }, CAPS, 'glm'), 'claude');
  assert.equal(pickBackend(null, { claude: 1, codex: 1, glm: 2 }, CAPS, 'glm'), 'codex');
});

test('a backend at its cap is skipped, and nothing is picked when all are full', () => {
  assert.equal(pickBackend(null, { claude: 2, codex: 2, glm: 2 }, CAPS, 'glm'), 'glm');
  assert.equal(pickBackend(null, { claude: 0, codex: 2, glm: 3 }, CAPS, 'glm'), 'claude');
  assert.equal(pickBackend(null, { claude: 2, codex: 2, glm: 3 }, CAPS, 'glm'), null);
});

test('a requested backend over its cap falls back to GLM, or waits when GLM is full too', () => {
  assert.equal(pickBackend('claude', { claude: 1, codex: 0, glm: 0 }, CAPS, 'glm'), 'claude');
  assert.equal(pickBackend('claude', { claude: 2, codex: 0, glm: 1 }, CAPS, 'glm'), 'glm');
  assert.equal(pickBackend('codex', { claude: 0, codex: 2, glm: 3 }, CAPS, 'glm'), null);
});

test("during GLM's peak hours an unrequested job prefers Claude and GPT, and GLM only when they are full", () => {
  assert.equal(pickBackend(null, { claude: 1, codex: 1, glm: 0 }, CAPS, 'glm', ['glm']), 'codex');
  assert.equal(pickBackend(null, { claude: 2, codex: 2, glm: 0 }, CAPS, 'glm', ['glm']), 'glm');
  assert.equal(pickBackend('glm', { claude: 0, codex: 0, glm: 0 }, CAPS, 'glm', ['glm']), 'glm');
});

test("GLM's peak hours are weekdays 14:00-18:00 UTC+8", () => {
  const window = { avoid: true, utcOffsetHours: 8, fromHour: 14, toHour: 18 };
  // Friday 2026-10-23, 06:00 UTC = 14:00 UTC+8 = 03:00 in Sao Paulo.
  assert.equal(isInGlmPeakHours(window, new Date('2026-10-23T06:00:00Z')), true);
  assert.equal(isInGlmPeakHours(window, new Date('2026-10-23T09:59:00Z')), true);
  assert.equal(isInGlmPeakHours(window, new Date('2026-10-23T10:00:00Z')), false);
  assert.equal(isInGlmPeakHours(window, new Date('2026-10-23T05:59:00Z')), false);
  // Saturday in UTC+8.
  assert.equal(isInGlmPeakHours(window, new Date('2026-10-24T07:00:00Z')), false);
});
