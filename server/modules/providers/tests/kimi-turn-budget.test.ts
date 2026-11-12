import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkKimiTurnInput,
  estimateTokens,
  evaluateKimiCallUsage,
  isKimiModel,
  KIMI_CALL_UNCACHED_INPUT_TOKENS,
  KIMI_TURN_OUTPUT_TOKENS,
  kimiOutputLimitConfig,
  mergeKimiOutputLimitConfig,
} from '../shared/kimi-turn-budget.js';

const promptOfTokens = (tokens: number): string => 'x'.repeat(tokens * 4);

test('Kimi model ids are recognised, DeepSeek ids are not', () => {
  assert.equal(isKimiModel('morph/morph-kimik31'), true);
  assert.equal(isKimiModel('morph/morph-kimik31-nothink'), true);
  assert.equal(isKimiModel('morph/morph-dsv41flash'), false);
  assert.equal(isKimiModel(null), false);
});

test('input budget: exactly 5000 tokens is allowed, 5001 is refused without truncation', () => {
  const at = checkKimiTurnInput({ model: 'morph/morph-kimik31', prompt: promptOfTokens(KIMI_CALL_UNCACHED_INPUT_TOKENS) });
  assert.equal(at.allowed, true);
  assert.equal(at.estimatedUncachedInputTokens, KIMI_CALL_UNCACHED_INPUT_TOKENS);
  assert.deepEqual(at.violations, []);

  const above = checkKimiTurnInput({ model: 'morph/morph-kimik31', prompt: promptOfTokens(KIMI_CALL_UNCACHED_INPUT_TOKENS + 1) });
  assert.equal(above.allowed, false);
  assert.equal(above.estimatedUncachedInputTokens, KIMI_CALL_UNCACHED_INPUT_TOKENS + 1);
  assert.deepEqual(above.violations, ['uncachedInput']);
  assert.match(above.reason ?? '', /not truncated/);
});

test('input budget does not apply to non-Kimi models', () => {
  const check = checkKimiTurnInput({ model: 'morph/morph-dsv41flash', prompt: promptOfTokens(20_000) });
  assert.equal(check.kimi, false);
  assert.equal(check.allowed, true);
});

test('output budget is passed as an OpenCode model limit of 800 tokens', () => {
  assert.deepEqual(kimiOutputLimitConfig('morph/morph-kimik31'), {
    provider: { morph: { models: { 'morph-kimik31': { limit: { output: KIMI_TURN_OUTPUT_TOKENS } } } } },
  });
  assert.equal(kimiOutputLimitConfig('morph/morph-dsv41flash'), null);
});

test('the output limit merges into an existing inline config and leaves malformed config alone', () => {
  const merged = mergeKimiOutputLimitConfig('{"theme":"dark"}', 'morph/morph-kimik31');
  assert.deepEqual(JSON.parse(merged ?? '{}'), {
    theme: 'dark',
    provider: { morph: { models: { 'morph-kimik31': { limit: { output: KIMI_TURN_OUTPUT_TOKENS } } } } },
  });
  assert.equal(mergeKimiOutputLimitConfig('{not json', 'morph/morph-kimik31'), '{not json');
  assert.equal(mergeKimiOutputLimitConfig(undefined, 'morph/morph-dsv41flash'), undefined);
});

test('call warnings: at each budget is clean, above either budget is flagged', () => {
  assert.equal(evaluateKimiCallUsage({
    role: 'hub',
    outputTokens: KIMI_TURN_OUTPUT_TOKENS,
    uncachedInputTokens: KIMI_CALL_UNCACHED_INPUT_TOKENS,
  }), null);

  const overOutput = evaluateKimiCallUsage({
    role: 'planner',
    outputTokens: KIMI_TURN_OUTPUT_TOKENS + 1,
    uncachedInputTokens: 10,
  });
  assert.deepEqual(overOutput?.violations, ['output']);

  const overInput = evaluateKimiCallUsage({
    role: 'jobs',
    outputTokens: 10,
    uncachedInputTokens: KIMI_CALL_UNCACHED_INPUT_TOKENS + 1,
  });
  assert.deepEqual(overInput?.violations, ['uncachedInput']);

  const both = evaluateKimiCallUsage({
    role: 'compaction',
    outputTokens: KIMI_TURN_OUTPUT_TOKENS + 1,
    uncachedInputTokens: KIMI_CALL_UNCACHED_INPUT_TOKENS + 1,
  });
  assert.deepEqual(both?.violations, ['output', 'uncachedInput']);
});

test('ordinary calls are not flagged and unavailable usage is not treated as zero', () => {
  assert.equal(evaluateKimiCallUsage({ role: 'hub', outputTokens: 100, uncachedInputTokens: 1_000 }), null);
  assert.equal(evaluateKimiCallUsage({ role: 'hub', outputTokens: null, uncachedInputTokens: null }), null);
  assert.equal(evaluateKimiCallUsage({ role: 'hub' }), null);
  // One reported field is still checked; the missing one is not invented as 0.
  const onlyOutput = evaluateKimiCallUsage({ role: 'hub', outputTokens: KIMI_TURN_OUTPUT_TOKENS + 1, uncachedInputTokens: null });
  assert.deepEqual(onlyOutput?.violations, ['output']);
  assert.equal(onlyOutput?.uncachedInputTokens, null);
});

test('token estimate is stable at the boundary', () => {
  assert.equal(estimateTokens('x'.repeat(4)), 1);
  assert.equal(estimateTokens('x'.repeat(5)), 2);
});
