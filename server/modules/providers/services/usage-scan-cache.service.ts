// Based on T3 Code (MIT): apps/server/src/usage/usageScanCache.ts
import type { JobTokenUsage } from '@/shared/types.js';

type CachedScanEntry = {
  size: number;
  mtimeMs: number;
  result: JobTokenUsage;
};

/** In-memory scan cache keyed by transcript path. */
const scanCache = new Map<string, CachedScanEntry>();

/**
 * Used by provider token usage service to check whether a transcript file has a cached scan result
 * with matching size and mtimeMs.
 */
export function getCachedScan(filePath: string, size: number, mtimeMs: number): JobTokenUsage | null {
  const entry = scanCache.get(filePath);
  if (entry && entry.size === size && entry.mtimeMs === mtimeMs) {
    return entry.result;
  }
  return null;
}

/**
 * Used by provider token usage service to store a scanned transcript's usage result.
 */
export function setCachedScan(filePath: string, size: number, mtimeMs: number, result: JobTokenUsage): void {
  scanCache.set(filePath, { size, mtimeMs, result });
}

/**
 * Used by test suites to clear cached scan entries.
 */
export function clearScanCache(): void {
  scanCache.clear();
}
