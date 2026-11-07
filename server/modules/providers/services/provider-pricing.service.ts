// Based on T3 Code (MIT): apps/server/src/usage/usagePricing.ts
import type { ModelTokenRates } from '@/shared/types.js';

import { MODEL_PRICES_DATA, PRICE_TABLE_VERSION } from './model-prices.data.js';

/**
 * Re-export the bundled price table version for cache key construction and external inspection.
 * Used by provider token usage service and scan cache to invalidate stale priced results.
 */
export { PRICE_TABLE_VERSION };

type LiteLlmPriceEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
};

/**
 * Used by provider token usage service and tests to represent mapped model rates.
 */
export type RateTable = Map<string, ModelTokenRates>;

/** Unpriceable models that must never return zero cost. */
const UNPRICEABLE_MODELS = new Set([
  '',
  '<synthetic>',
  'synthetic',
  'unknown',
  'unpriced',
]);

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf('[');
  return bracket === -1 ? key : key.slice(0, bracket);
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Used by loadDefaultRateTable and tests to parse raw price data into RateTable.
 * Throws an explicit error if the raw table is empty or missing, never returning a silent 0-rate map.
 */
export function parsePriceTable(rawJson: Record<string, unknown>): RateTable {
  if (!rawJson || typeof rawJson !== 'object' || Object.keys(rawJson).length === 0) {
    throw new Error('Pricing table is missing or empty');
  }
  const table: RateTable = new Map();
  for (const [key, val] of Object.entries(rawJson)) {
    if (!val || typeof val !== 'object') continue;
    const entry = val as LiteLlmPriceEntry;
    const input = typeof entry.input_cost_per_token === 'number' && Number.isFinite(entry.input_cost_per_token)
      ? entry.input_cost_per_token
      : null;
    const output = typeof entry.output_cost_per_token === 'number' && Number.isFinite(entry.output_cost_per_token)
      ? entry.output_cost_per_token
      : null;
    if (input === null || output === null) continue;

    const cacheRead = typeof entry.cache_read_input_token_cost === 'number' && Number.isFinite(entry.cache_read_input_token_cost)
      ? entry.cache_read_input_token_cost
      : input;
    const cacheCreation = typeof entry.cache_creation_input_token_cost === 'number' && Number.isFinite(entry.cache_creation_input_token_cost)
      ? entry.cache_creation_input_token_cost
      : input;

    const normalized = normalizeRateKey(key);
    table.set(normalized, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: cacheRead,
      cacheCreationCostPerToken: cacheCreation,
    });
  }
  if (table.size === 0) {
    throw new Error('Pricing table contains no valid rate entries');
  }
  return table;
}

let defaultRateTable: RateTable | null = null;

/**
 * Used by provider token usage service to obtain the default rate table.
 * Throws an explicit error if the table cannot be parsed or is empty.
 */
export function loadDefaultRateTable(): RateTable {
  if (!defaultRateTable) {
    defaultRateTable = parsePriceTable(MODEL_PRICES_DATA as Record<string, unknown>);
  }
  if (defaultRateTable.size === 0) {
    throw new Error('Default rate table is empty');
  }
  return defaultRateTable;
}

/**
 * Used by provider token usage service to lookup pricing for a model name.
 */
export function lookupModelRate(model: string | null | undefined, customTable?: RateTable): ModelTokenRates | null {
  if (!model) return null;
  const table = customTable ?? loadDefaultRateTable();
  if (table.size === 0) {
    throw new Error('Rate table is empty');
  }
  const normalized = stripVariantSuffix(normalizeRateKey(model));
  if (UNPRICEABLE_MODELS.has(normalized)) return null;

  // Direct match
  if (table.has(normalized)) return table.get(normalized)!;

  // Bare name match (e.g. anthropic/claude-opus-5-5 -> claude-opus-5-5)
  const bare = bareModelName(normalized);
  if (table.has(bare)) return table.get(bare)!;

  // Common prefix / alias matching for known configurations
  if (bare === 'claude' || bare === 'opus') return table.get('claude-opus-5-5') ?? null;
  if (bare === 'gpt' || bare === 'gpt terra') return table.get('gpt-6.1-terra') ?? null;
  if (bare === 'gpt sol') return table.get('gpt-6.1-sol') ?? null;
  if (bare === 'glm' || bare === 'glm flash') return table.get('glm-5.3-flash') ?? null;
  if (bare === 'gemini' || bare === 'gemini flash') return table.get('gemini-3.8-flash-medium') ?? null;

  return null;
}

/**
 * Used by provider token usage service to compute notional equivalent API cost.
 * When the model is unknown or unpriceable, costSource is 'unpriced' and notionalCostUsd is null (never 0).
 */
export function calculateNotionalCost(
  totals: {
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
  },
  model: string | null | undefined,
  customTable?: RateTable,
): { notionalCostUsd: number | null; costSource: 'notional' | 'unpriced' } {
  const rate = lookupModelRate(model, customTable);
  if (!rate) {
    return { notionalCostUsd: null, costSource: 'unpriced' };
  }

  const cost =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;

  return {
    notionalCostUsd: cost,
    costSource: 'notional',
  };
}
