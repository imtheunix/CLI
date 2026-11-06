import { appConfigDb } from '@/modules/database/index.js';

export { detectGlmQuotaReset } from '@/shared/glm-quota.js';

const QUOTA_KEY = 'orchestrator.glm.quotaUntil';

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
