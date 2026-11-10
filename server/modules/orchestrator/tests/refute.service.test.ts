import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';

import type { OrchestratorConfig } from '../services/orchestrator-config.service.js';
import { parseRefuteVerdict, selectRefuteBackend } from '../services/refute.service.js';

function response(content: string): Parameters<typeof parseRefuteVerdict>[0] {
  return [{ kind: 'text', role: 'assistant', content }, { kind: 'complete', exitCode: 0 }];
}

test('refutation uses a different configured model family for each producer', () => {
  const config = { review: { refuteBackendFor: {} } } as OrchestratorConfig;
  const expected: Array<[OrchestratorBackend, OrchestratorBackend]> = [
    ['morph', 'glm'],
    ['glm', 'morph'],
    ['zcode', 'morph'],
    ['claude', 'glm'],
    ['codex', 'glm'],
  ];

  for (const [producer, refuter] of expected) {
    const job = { backend: producer, requested_backend: producer } as OrchestratorJobRow;
    assert.equal(selectRefuteBackend(job, config), refuter, `${producer} must be refuted by ${refuter}`);
  }
  config.review.refuteBackendFor.glm = 'glm';
  assert.equal(selectRefuteBackend({ backend: 'glm' } as OrchestratorJobRow, config), 'morph', 'a same-family override is ignored');
});

test('refutation parses strict pass and evidence-backed defects verdicts', () => {
  assert.deepEqual(parseRefuteVerdict(response('{"verdict":"pass","defects":[]}')), {
    verdict: 'pass',
    defects: [],
  });

  assert.deepEqual(parseRefuteVerdict(response(JSON.stringify({
    verdict: 'defects',
    defects: [{ what: ' stale status ', probe: ' npm test -- status ', output: ' expected ready, received stale ' }],
  }))), {
    verdict: 'defects',
    defects: [{ what: 'stale status', probe: 'npm test -- status', output: 'expected ready, received stale' }],
  });
});

test('refutation rejects prose, fencing, malformed JSON, and invalid verdict shapes', () => {
  const valid = '{"verdict":"pass","defects":[]}';
  const invalid = [
    ['prose before JSON', `Review complete.\n${valid}`],
    ['prose after JSON', `${valid}\nNo defects found.`],
    ['fenced JSON', `\`\`\`json\n${valid}\n\`\`\``],
    ['malformed JSON', '{"verdict":"pass","defects":[}'],
    ['unknown verdict', '{"verdict":"maybe","defects":[]}'],
    ['missing defects array', '{"verdict":"pass"}'],
    ['non-array defects', '{"verdict":"pass","defects":{}}'],
    ['defects without a defect', '{"verdict":"defects","defects":[]}'],
    ['pass contradicting a defect', '{"verdict":"pass","defects":[{"what":"bad","probe":"npm test","output":"failed"}]}'],
  ];

  for (const [name, content] of invalid) {
    assert.throws(() => parseRefuteVerdict(response(content)), Error, name);
  }
});

test('refutation requires reproduced probe and output evidence for every defect', () => {
  const incomplete = [
    { what: 'missing probe', output: 'failure' },
    { what: 'blank probe', probe: '  ', output: 'failure' },
    { what: 'missing output', probe: 'npm test' },
    { what: 'blank output', probe: 'npm test', output: '  ' },
  ];

  for (const defect of incomplete) {
    assert.throws(
      () => parseRefuteVerdict(response(JSON.stringify({ verdict: 'defects', defects: [defect] }))),
      /what, probe and reproduced output/,
      defect.what,
    );
  }
});
