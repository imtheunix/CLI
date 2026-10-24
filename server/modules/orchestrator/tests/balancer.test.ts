import assert from 'node:assert/strict';
import test from 'node:test';

import { pickBackend } from '@/modules/orchestrator/services/balancer.service.js';

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
