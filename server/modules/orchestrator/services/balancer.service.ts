import type { OrchestratorBackend } from '@/modules/database/index.js';

import { BACKEND_TIE_ORDER } from './orchestrator-config.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';

/**
 * Used by the jobs service to know whether GLM is in Z.ai's peak hours:
 * weekdays, `fromHour` to `toHour`, at the window's UTC offset.
 */
export function isInGlmPeakHours(window: OrchestratorConfig['glmPeakHours'], now: Date): boolean {
  const local = new Date(now.getTime() + window.utcOffsetHours * 3_600_000);
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  return day >= 1 && day <= 5 && hour >= window.fromHour && hour < window.toHour;
}

/**
 * Used by the jobs service to give a job a backend. Pure: the loads (active
 * jobs per backend) and caps come in, a backend or `null` (wait in the queue)
 * comes out.
 *
 * - A job that asked for a backend gets it while it is under its cap, and the
 *   fallback (GLM) when it is not.
 * - Any other job goes to whichever backend is working on the fewest jobs,
 *   among those under their cap; ties go to the cheapest. A backend in
 *   `avoid` (GLM in its peak hours) is picked only when no other has room.
 * - Exhausted GLM is excluded even for explicit requests; quota fallback uses
 *   agy within its cap, or waits. Ordinary auto selection does not use agy.
 */
export function pickBackend(
  requested: OrchestratorBackend | null,
  loads: Partial<Record<OrchestratorBackend, number>>,
  caps: Partial<Record<OrchestratorBackend, number>>,
  fallback: OrchestratorBackend,
  avoid: OrchestratorBackend[] = [],
  quota: { glmExhausted: boolean; fallback: 'agy' | 'wait' } = { glmExhausted: false, fallback: 'agy' },
): OrchestratorBackend | null {
  const isGlmExhausted = (backend: OrchestratorBackend) => (backend === 'glm' || backend === 'zcode') && quota.glmExhausted;
  const hasRoom = (backend: OrchestratorBackend) => !isGlmExhausted(backend)
    && (loads[backend] ?? 0) < (caps[backend] ?? 0);
  const effectiveFallback = quota.glmExhausted && (fallback === 'glm' || fallback === 'zcode')
    ? (quota.fallback === 'agy' ? 'agy' : null) : fallback;
  if ((requested === 'glm' || requested === 'zcode') && quota.glmExhausted) {
    return quota.fallback === 'agy' && hasRoom('agy') ? 'agy' : null;
  }

  if (requested) {
    if (hasRoom(requested)) return requested;
    return effectiveFallback && hasRoom(effectiveFallback) ? effectiveFallback : null;
  }

  const leastLoaded = (backends: OrchestratorBackend[]) => {
    let best: OrchestratorBackend | null = null;
    for (const backend of backends) {
      if (!hasRoom(backend)) continue;
      if (best === null || (loads[backend] ?? 0) < (loads[best] ?? 0)) best = backend;
    }
    return best;
  };
  const order = quota.glmExhausted && quota.fallback === 'agy' ? ['agy', ...BACKEND_TIE_ORDER] as OrchestratorBackend[] : BACKEND_TIE_ORDER;
  return leastLoaded(order.filter((backend) => !avoid.includes(backend))) ?? leastLoaded(order);
}
