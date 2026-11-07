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
  PRICE_TABLE_VERSION,
} from '../services/provider-pricing.service.js';
import {
  createProviderTokenUsageService,
  parseClaudeTranscriptTokens,
  parseCodexTranscriptTokens,
  parseZcodeTranscriptTokens,
} from '../services/provider-token-usage.service.js';
import { buildScanCacheKey, clearScanCache } from '../services/usage-scan-cache.service.js';

test('provider pricing: price table is bundled as a TS module and never empty', async () => {
  // Assert the module import path exists and exports rate data
  const { MODEL_PRICES_DATA, PRICE_TABLE_VERSION: importedVersion } = await import(
    '../services/model-prices.data.js'
  );
  assert.ok(MODEL_PRICES_DATA, 'MODEL_PRICES_DATA must be exported');
  assert.equal(typeof MODEL_PRICES_DATA, 'object');
  assert.ok(Object.keys(MODEL_PRICES_DATA).length >= 20, 'price table must contain at least 20 models');
  assert.equal(importedVersion, '2026-11-07');
  assert.equal(PRICE_TABLE_VERSION, '2026-11-07');

  const table = loadDefaultRateTable();
  assert.ok(table.size >= 20);
  assert.ok(table.has('gpt-6.1-sol'), 'bundled table must contain gpt-6.1-sol');
  assert.ok(table.has('gpt-6.1-terra'), 'bundled table must contain gpt-6.1-terra');
  assert.ok(table.has('glm-5.3'), 'bundled table must contain glm-5.3');
  assert.ok(table.has('claude-opus-5-5'), 'bundled table must contain claude-opus-5-5');

  // Assert empty or invalid tables throw explicit errors rather than returning a silent 0-rate map
  assert.throws(() => parsePriceTable({}), /missing or empty/i);
  assert.throws(() => parsePriceTable({ invalid: {} }), /contains no valid rate entries/i);
  assert.throws(() => lookupModelRate('gpt-6.1-sol', new Map()), /rate table is empty/i);
});

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
    // In Zcode, input_tokens already includes cache_read_input_tokens:
    // Turn 1: 1000 total input (400 cached, 600 uncached)
    // Turn 2: 2000 total input (1400 cached, 600 uncached)
    // Total input: 1000 + 2000 = 3000 (never 4800)
    // Cached: 400 + 1400 = 1800
    // Uncached: 600 + 600 = 1200
    // Cache write: 100 + 50 = 150
    // Output: 300 + 400 = 700
    assert.equal(result.inputTokens, 3000);
    assert.equal(result.cacheReadTokens, 1800);
    assert.equal(result.cacheCreationTokens, 150);
    assert.equal(result.cacheTokens, 1950);
    assert.equal(result.outputTokens, 700);
    assert.equal(result.model, 'GLM-5.3-Flash');
    assert.equal(result.costSource, 'notional');
    assert.equal(result.isNotional, true);

    // GLM-5.3-Flash rates:
    // input 0.0000001, cacheRead 0.00000005, cacheWrite 0.0000001, output 0.0000001
    // Uncached: 1200 * 0.0000001 = 0.00012
    // Cached read: 1800 * 0.00000005 = 0.00009
    // Cache write: 150 * 0.0000001 = 0.000015
    // Output: 700 * 0.0000001 = 0.00007
    // Total = 0.000295
    assert.ok(typeof result.notionalCostUsd === 'number');
    assert.ok(Math.abs(result.notionalCostUsd - 0.000295) < 1e-6);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provider token usage: Zcode synthetic reproducer covering both shared id and input includes cache', async () => {
  clearScanCache();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fixture-zcode-reproducer-'));
  const filePath = path.join(tempDir, 'session.jsonl');

  try {
    // Reproduces the exact structure of real transcript 404889af-f4d9-45d9-b645-950a09e2cc27.jsonl:
    // Multiple session.updated rows share turnId 'turn-repro-1' with interim request usage.
    // Followed by turn.completed with the same turnId reporting cumulative turn totals.
    const sharedTurnId = 'bb53318b-612e-463c-8aa6-cb2f92464400';
    const lines = [
      JSON.stringify({
        type: 'session.updated',
        turnId: sharedTurnId,
        id: 'msg-part-1',
        payload: {
          modelId: 'GLM-5.3',
          usage: {
            inputTokens: 234250,
            outputTokens: 71,
            totalTokens: 234321,
            cacheReadTokens: 234176,
            cacheWriteTokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: 'session.updated',
        turnId: sharedTurnId,
        id: 'msg-part-2',
        payload: {
          usage: {
            inputTokens: 234714,
            outputTokens: 1699,
            totalTokens: 236413,
            cacheReadTokens: 234240,
            cacheWriteTokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        turnId: sharedTurnId,
        id: 'turn-end-1',
        payload: {
          source: 'provider',
          modelRequestCount: 7,
          inputTokens: 1657050,
          outputTokens: 3454,
          totalTokens: 1660504,
          cacheReadTokens: 1652736,
          cacheWriteTokens: 0,
        },
      }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const service = createProviderTokenUsageService();
    const result = service.getTranscriptJobUsage(filePath, 'zcode');

    assert.ok(result);
    // Defect 1: session.updated interim events must not be used or lock out turn.completed
    assert.notEqual(result.outputTokens, 71, 'must not return interim session.updated outputTokens');
    assert.equal(result.outputTokens, 3454, 'must use turn.completed outputTokens');

    // Defect 2: input already includes cached tokens, so never add cacheRead on top
    assert.notEqual(
      result.inputTokens,
      1657050 + 1652736,
      'must not add cacheReadTokens on top of inputTokens',
    );
    assert.notEqual(
      result.inputTokens,
      468426,
      'must not return erroneous double-counted interim inputTokens',
    );
    assert.equal(result.inputTokens, 1657050);
    assert.equal(result.cacheReadTokens, 1652736);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.model, 'GLM-5.3');

    // Pricing calculation check:
    // GLM-5.3 rates: input 0.000001, cacheRead 0.0000005, output 0.000002
    // Uncached input: 1,657,050 - 1,652,736 = 4,314 tokens
    // 4,314 * 0.000001 = 0.004314
    // 1,652,736 * 0.0000005 = 0.826368
    // 3,454 * 0.000002 = 0.006908
    // Expected total = 0.837590
    assert.ok(typeof result.notionalCostUsd === 'number');
    assert.ok(Math.abs(result.notionalCostUsd - 0.83759) < 1e-5);
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

test('provider token usage: scan cache key includes price table version, rate inputs, and fallback model', async () => {
  clearScanCache();

  // Test buildScanCacheKey directly
  const baseKey1 = buildScanCacheKey('/test/path.jsonl', '2026-11-07');
  const baseKey2 = buildScanCacheKey('/test/path.jsonl', '2026-11-07');
  assert.equal(baseKey1, baseKey2);

  // Different table versions must produce different cache keys
  const v2Key = buildScanCacheKey('/test/path.jsonl', '2026-12-01');
  assert.notEqual(baseKey1, v2Key);

  // Different fallback models must produce different cache keys
  const modelAKey = buildScanCacheKey('/test/path.jsonl', '2026-11-07', 'gpt-6.1-terra');
  const modelBKey = buildScanCacheKey('/test/path.jsonl', '2026-11-07', 'gpt-6.1-sol');
  assert.notEqual(modelAKey, modelBKey);
  assert.notEqual(baseKey1, modelAKey);

  // Custom rates must produce different cache keys
  const customTable = new Map([
    ['gpt-6.1-terra', { inputCostPerToken: 0.0001, outputCostPerToken: 0.0002, cacheReadCostPerToken: 0.00005, cacheCreationCostPerToken: 0.0001 }],
  ]);
  const customKey = buildScanCacheKey('/test/path.jsonl', '2026-11-07', undefined, customTable);
  assert.notEqual(baseKey1, customKey);

  // End-to-end service cache invalidation on changed inputs
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cache-key-invalidation-'));
  const filePath = path.join(tempDir, 'transcript.jsonl');

  try {
    const transcriptContent = JSON.stringify({
      type: 'assistant',
      message: {
        // Omitting model so fallbackModel is used
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    }) + '\n';
    await writeFile(filePath, transcriptContent);

    let readCallCount = 0;
    const service = createProviderTokenUsageService({
      readFileSync: () => {
        readCallCount += 1;
        return transcriptContent;
      },
    });

    // 1. First scan with fallback model 'claude-opus-5-5' -> miss, readCallCount = 1
    const run1 = service.getTranscriptJobUsage(filePath, 'claude', 'claude-opus-5-5');
    assert.ok(run1);
    assert.equal(run1.model, 'claude-opus-5-5');
    assert.equal(readCallCount, 1);

    // 2. Second scan with identical parameters -> CACHE HIT, readCallCount remains 1
    const run2 = service.getTranscriptJobUsage(filePath, 'claude', 'claude-opus-5-5');
    assert.ok(run2);
    assert.equal(readCallCount, 1, 'must hit cache when fallbackModel and rates match');
    assert.deepEqual(run2, run1);

    // 3. Third scan with DIFFERENT fallback model 'gpt-6.1-terra' -> CACHE MISS, readCallCount = 2
    const run3 = service.getTranscriptJobUsage(filePath, 'claude', 'gpt-6.1-terra');
    assert.ok(run3);
    assert.equal(run3.model, 'gpt-6.1-terra');
    assert.equal(readCallCount, 2, 'must not return stale result when fallbackModel changes');
    assert.notEqual(run3.notionalCostUsd, run1.notionalCostUsd);

    // 4. Fourth scan with CUSTOM rates -> CACHE MISS, readCallCount = 3
    const customServiceTable = new Map([
      ['gpt-6.1-terra', { inputCostPerToken: 0.01, outputCostPerToken: 0.05, cacheReadCostPerToken: 0.005, cacheCreationCostPerToken: 0.01 }],
    ]);
    const run4 = service.getTranscriptJobUsage(filePath, 'claude', 'gpt-6.1-terra', customServiceTable);
    assert.ok(run4);
    assert.equal(readCallCount, 3, 'must not return stale result when customRates change');
    assert.notEqual(run4.notionalCostUsd, run3.notionalCostUsd);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
