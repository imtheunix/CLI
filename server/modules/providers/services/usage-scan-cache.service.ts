// Based on T3 Code (MIT): apps/server/src/usage/usageScanCache.ts
import type { JobTokenUsage, ModelTokenRates } from '@/shared/types.js';

type RateTable = Map<string, ModelTokenRates>;

type CachedScanEntry = {
  size: number;
  mtimeMs: number;
  result: JobTokenUsage;
};

/** In-memory scan cache keyed by transcript path and pricing inputs. */
const scanCache = new Map<string, CachedScanEntry>();

/**
 * Builds a deterministic scan cache key incorporating transcript path, price table version,
 * fallback model, and any custom rate inputs.
 * Used by provider token usage service to prevent returning stale priced results when
 * rates or models change.
 */
export function buildScanCacheKey(
  target: string,
  priceTableVersion: string,
  fallbackModel?: string | null,
  customRates?: RateTable,
): string {
  const modelPart = fallbackModel ? `model:${fallbackModel}` : 'model:none';
  let ratesPart: string;
  if (!customRates || customRates.size === 0) {
    ratesPart = `table:${priceTableVersion}`;
  } else {
    const entries = [...customRates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, r]) => `${k}:${r.inputCostPerToken},${r.outputCostPerToken},${r.cacheReadCostPerToken},${r.cacheCreationCostPerToken}`)
      .join('|');
    ratesPart = `table:${priceTableVersion}:custom:${entries}`;
  }
  return `${target}::${ratesPart}::${modelPart}`;
}

/**
 * Used by provider token usage service to check whether a transcript file has a cached scan result
 * with matching size and mtimeMs.
 */
export function getCachedScan(key: string, size: number, mtimeMs: number): JobTokenUsage | null {
  const entry = scanCache.get(key);
  if (entry && entry.size === size && entry.mtimeMs === mtimeMs) {
    return entry.result;
  }
  return null;
}

/**
 * Used by provider token usage service to store a scanned transcript's usage result.
 */
export function setCachedScan(key: string, size: number, mtimeMs: number, result: JobTokenUsage): void {
  scanCache.set(key, { size, mtimeMs, result });
}

/**
 * Used by test suites to clear cached scan entries.
 */
export function clearScanCache(): void {
  scanCache.clear();
}
