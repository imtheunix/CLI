import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  calculateNotionalCost,
  loadDefaultRateTable,
  lookupModelRate,
  parsePriceTable,
} from '../services/provider-pricing.service.js';
import {
  createProviderTokenUsageService,
  parseClaudeTranscriptTokens,
  parseCodexTranscriptTokens,
  parseZcodeTranscriptTokens,
} from '../services/provider-token-usage.service.js';
import { clearScanCache } from '../services/usage-scan-cache.service.js';

test('provider pricing: rate table lookup and aliases', () => {
  const table = loadDefaultRateTable();

  // Standard backends from ~/.config/cli/orchestrator.json
  const claudeRate = lookupModelRate('claude-opus-5-5', table);
  assert.ok(claudeRate);
  assert.equal(claudeRate.inputCostPerToken, 0.000015);
  assert.equal(claudeRate.outputCostPerToken, 0.000075);
  assert.equal(claudeRate.cacheReadCostPerToken, 0.0000015);
  assert.equal(claudeRate.cacheCreationCostPerToken, 0.00001875);

  const codexRate = lookupModelRate('gpt-6.1-terra', table);
  assert.ok(codexRate);
  assert.equal(codexRate.inputCostPerToken, 0.0000025);
  assert.equal(codexRate.outputCostPerToken, 0.00001);

  const zcodeRate = lookupModelRate('GLM-5.3-Flash', table);
  assert.ok(zcodeRate);
  assert.equal(zcodeRate.inputCostPerToken, 0.0000001);
  assert.equal(zcodeRate.outputCostPerToken, 0.0000001);

  const agyRate = lookupModelRate('gemini-3.8-flash-medium', table);
  assert.ok(agyRate);
  assert.equal(agyRate.inputCostPerToken, 0.00000015);
  assert.equal(agyRate.outputCostPerToken, 0.0000006);

  // Normalization: bare name and brackets
  const prefixedClaude = lookupModelRate('anthropic/claude-opus-5-5[1m]', table);
  assert.deepEqual(prefixedClaude, claudeRate);
});

test('provider pricing: unknown model -> unpriced, never 0', () => {
  const table = loadDefaultRateTable();

  const unknownModels = ['unknown-model-v1', 'future-gpt-9', '<synthetic>', ''];
  for (const model of unknownModels) {
    const rate = lookupModelRate(model, table);
    assert.equal(rate, null);

    const costResult = calculateNotionalCost(
      {
        uncachedInputTokens: 1000,
        cachedInputTokens: 500,
        cacheCreationTokens: 100,
        outputTokens: 200,
      },
      model,
      table,
    );

    assert.equal(costResult.costSource, 'unpriced');
    assert.equal(costResult.notionalCostUsd, null);
    assert.notEqual(costResult.notionalCostUsd, 0, 'unknown model must never be reported as 0 cost');
  }
});

test('provider token usage: Claude format transcript fixture', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fixture-claude-'));
  const filePath = path.join(tempDir, 'session.jsonl');

  try {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-turn-1',
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 20,
            output_tokens: 50,
          },
        },
      }),
      // Repeated chunk with same id should be deduped
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-turn-1',
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 20,
            output_tokens: 50,
          },
        },
      }),
      // Second turn with different message id
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-turn-2',
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 200,
            cache_read_input_tokens: 160,
            cache_creation_input_tokens: 10,
            output_tokens: 80,
          },
        },
      }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const service = createProviderTokenUsageService();
    const result = service.getTranscriptJobUsage(filePath, 'claude');

    assert.ok(result);
    // Uncached input: 100 + 200 = 300
    // Cached input: 40 + 160 = 200
    // Total input: 500
    // Cache creation: 20 + 10 = 30
    // Cache total: 200 + 30 = 230
    // Output: 50 + 80 = 130
    assert.equal(result.inputTokens, 500);
    assert.equal(result.cacheReadTokens, 200);
    assert.equal(result.cacheCreationTokens, 30);
    assert.equal(result.cacheTokens, 230);
    assert.equal(result.outputTokens, 130);
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.costSource, 'notional');
    assert.equal(result.isNotional, true);

    // Expected Opus cost:
    // 300 * 0.000015 = 0.0045
    // 200 * 0.0000015 = 0.0003
    // 30 * 0.00001875 = 0.0005625
    // 130 * 0.000075 = 0.00975
    // Total = 0.0151125
    assert.ok(typeof result.notionalCostUsd === 'number');
    assert.ok(Math.abs(result.notionalCostUsd - 0.0151125) < 1e-6);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provider token usage: Codex format transcript fixture', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fixture-codex-'));
  const filePath = path.join(tempDir, 'rollout.jsonl');

  try {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-terra' } }),
      // Earlier snapshot
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 30,
              cache_write_input_tokens: 10,
              output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
      }),
      // Latest cumulative snapshot
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 200,
              cache_write_input_tokens: 50,
              output_tokens: 100,
              total_tokens: 600,
            },
          },
        },
      }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const service = createProviderTokenUsageService();
    const result = service.getTranscriptJobUsage(filePath, 'codex');

    assert.ok(result);
    // Uncached: 500 - 200 = 300
    // Cached: 200
    // Total input: 500
    // Cache creation: 50
    // Output: 100
    assert.equal(result.inputTokens, 500);
    assert.equal(result.cacheReadTokens, 200);
    assert.equal(result.cacheCreationTokens, 50);
    assert.equal(result.cacheTokens, 250);
    assert.equal(result.outputTokens, 100);
    assert.equal(result.model, 'gpt-6.1-terra');
    assert.equal(result.costSource, 'notional');
    assert.equal(result.isNotional, true);

    // GPT-6.1-Terra rates: input 0.0000025, cacheRead 0.00000125, cacheWrite 0.0000025, output 0.00001
    // 300 * 0.0000025 = 0.00075
    // 200 * 0.00000125 = 0.00025
    // 50 * 0.0000025 = 0.000125
    // 100 * 0.00001 = 0.001
    // Total = 0.002125
    assert.ok(typeof result.notionalCostUsd === 'number');
    assert.ok(Math.abs(result.notionalCostUsd - 0.002125) < 1e-6);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provider token usage: Zcode format transcript fixture', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fixture-zcode-'));
  const filePath = path.join(tempDir, 'session.jsonl');

  try {
    const lines = [
      JSON.stringify({
        type: 'session.updated',
        sessionId: 'sess_zcode_1',
        payload: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash' },
      }),
      JSON.stringify({ event: 'init', init: { model: 'GLM-5.3-Flash' } }),
      JSON.stringify({
        type: 'turn.completed',
        sessionId: 'sess_zcode_1',
        turnId: 'turn-1',
        payload: {
          resultType: 'success',
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 100,
            output_tokens: 300,
          },
        },
      }),
      // Second turn
      JSON.stringify({
        type: 'turn.completed',
        sessionId: 'sess_zcode_1',
        turnId: 'turn-2',
        payload: {
          resultType: 'success',
          usage: {
            input_tokens: 2000,
            cache_read_input_tokens: 1400,
            cache_creation_input_tokens: 50,
            output_tokens: 400,
          },
        },
      }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const service = createProviderTokenUsageService();
    const result = service.getTranscriptJobUsage(filePath, 'zcode');

    assert.ok(result);
    // Uncached: 1000 + 2000 = 3000
    // Cached: 400 + 1400 = 1800
    // Total input: 4800
    // Cache write: 100 + 50 = 150
    // Output: 300 + 400 = 700
    assert.equal(result.inputTokens, 4800);
    assert.equal(result.cacheReadTokens, 1800);
    assert.equal(result.cacheCreationTokens, 150);
    assert.equal(result.cacheTokens, 1950);
    assert.equal(result.outputTokens, 700);
    assert.equal(result.model, 'GLM-5.3-Flash');
    assert.equal(result.costSource, 'notional');
    assert.equal(result.isNotional, true);

    // GLM-5.3-Flash rates:
    // input 0.0000001, cacheRead 0.00000005, cacheWrite 0.0000001, output 0.0000001
    // 3000 * 0.0000001 = 0.0003
    // 1800 * 0.00000005 = 0.00009
    // 150 * 0.0000001 = 0.000015
    // 700 * 0.0000001 = 0.00007
    // Total = 0.000475
    assert.ok(typeof result.notionalCostUsd === 'number');
    assert.ok(Math.abs(result.notionalCostUsd - 0.000475) < 1e-6);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provider token usage: cache-hit test keyed by path + size + mtime', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cache-hit-test-'));
  const filePath = path.join(tempDir, 'transcript.jsonl');

  try {
    const initialContent = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    }) + '\n';
    await writeFile(filePath, initialContent);

    let readCallCount = 0;
    const service = createProviderTokenUsageService({
      readFileSync: (target) => {
        readCallCount += 1;
        return initialContent;
      },
    });

    // First scan: cache miss -> reads file
    const firstResult = service.getTranscriptJobUsage(filePath, 'claude');
    assert.ok(firstResult);
    assert.equal(firstResult.inputTokens, 50);
    assert.equal(readCallCount, 1);

    // Second scan with same path + size + mtime: CACHE HIT!
    const secondResult = service.getTranscriptJobUsage(filePath, 'claude');
    assert.ok(secondResult);
    assert.equal(secondResult.inputTokens, 50);
    assert.equal(readCallCount, 1, 'readFileSync must not be called again on cache hit');
    assert.deepEqual(secondResult, firstResult);

    // Change file modification time -> cache miss
    await utimes(filePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const thirdResult = service.getTranscriptJobUsage(filePath, 'claude');
    assert.ok(thirdResult);
    assert.equal(readCallCount, 2, 'readFileSync should be called again after mtime changed');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provider token usage: unknown model produces unpriced, never 0', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'unpriced-model-test-'));
  const filePath = path.join(tempDir, 'transcript.jsonl');

  try {
    await writeFile(filePath, JSON.stringify({
      type: 'assistant',
      message: {
        model: 'some-nonexistent-future-model-99',
        usage: { input_tokens: 120, output_tokens: 45 },
      },
    }) + '\n');

    const service = createProviderTokenUsageService();
    const result = service.getTranscriptJobUsage(filePath, 'claude');

    assert.ok(result);
    assert.equal(result.inputTokens, 120);
    assert.equal(result.outputTokens, 45);
    assert.equal(result.model, 'some-nonexistent-future-model-99');
    assert.equal(result.costSource, 'unpriced');
    assert.equal(result.notionalCostUsd, null);
    assert.notEqual(result.notionalCostUsd, 0, 'cost must never be 0 for unpriced model');
    assert.equal(result.isNotional, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
