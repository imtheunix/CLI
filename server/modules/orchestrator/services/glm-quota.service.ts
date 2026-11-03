import { appConfigDb } from '@/modules/database/index.js';

const QUOTA_KEY = 'orchestrator.glm.quotaUntil';

/** Jobs service/tests: recognize Z.ai plan exhaustion, never a generic HTTP 429. */
export function detectGlmQuotaReset(text: string, now: Date): Date | null {
  // Observed in six OpenCode APIErrors on 2026-11-02 (Z.ai code 1308).
  if (!/Usage limit reached for \d+\s+(?:hour|day|week|month)s?\b/i.test(text)) return null;
  const reset = /Your limit will reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?/i.exec(text);
  // Z.ai's unqualified wall time is UTC+8, as confirmed against response Date headers.
  const timestamp = reset ? Date.parse(`${reset[1]}T${reset[2]}${reset[3] ?? '+08:00'}`) : NaN;
  return new Date(Number.isFinite(timestamp) && timestamp > now.getTime() ? timestamp : now.getTime() + 3_600_000);
}

/** Jobs service: persist GLM's cooldown across orchestrator restarts. */
export function recordGlmQuotaReset(until: Date): void {
  const previous = appConfigDb.get(QUOTA_KEY);
  const latest = Math.max(Date.parse(previous ?? '') || 0, until.getTime());
  appConfigDb.set(QUOTA_KEY, new Date(latest).toISOString());
}

/** Jobs service: expired cooldowns automatically make GLM eligible again. */
export function getGlmQuotaReset(now: Date): string | null {
  const until = appConfigDb.get(QUOTA_KEY);
  return until && Date.parse(until) > now.getTime() ? until : null;
}
