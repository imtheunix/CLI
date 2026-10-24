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
 */
export function pickBackend(
  requested: OrchestratorBackend | null,
  loads: Record<OrchestratorBackend, number>,
  caps: Record<OrchestratorBackend, number>,
  fallback: OrchestratorBackend,
  avoid: OrchestratorBackend[] = [],
): OrchestratorBackend | null {
  const hasRoom = (backend: OrchestratorBackend) => loads[backend] < caps[backend];

  if (requested) {
    if (hasRoom(requested)) return requested;
    return hasRoom(fallback) ? fallback : null;
  }

  const leastLoaded = (backends: OrchestratorBackend[]) => {
    let best: OrchestratorBackend | null = null;
    for (const backend of backends) {
      if (!hasRoom(backend)) continue;
      if (best === null || loads[backend] < loads[best]) best = backend;
    }
    return best;
  };
  return leastLoaded(BACKEND_TIE_ORDER.filter((backend) => !avoid.includes(backend))) ?? leastLoaded(BACKEND_TIE_ORDER);
}
