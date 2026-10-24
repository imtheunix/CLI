import type { OrchestratorBackend } from '@/modules/database/index.js';

import { BACKEND_TIE_ORDER } from './orchestrator-config.service.js';

/**
 * Used by the jobs service to give a job a backend. Pure: the loads (active
 * jobs per backend) and caps come in, a backend or `null` (wait in the queue)
 * comes out.
 *
 * - A job that asked for a backend gets it while it is under its cap, and the
 *   fallback (GLM) when it is not.
 * - Any other job goes to whichever backend is working on the fewest jobs,
 *   among those under their cap; ties go to the cheapest.
 */
export function pickBackend(
  requested: OrchestratorBackend | null,
  loads: Record<OrchestratorBackend, number>,
  caps: Record<OrchestratorBackend, number>,
  fallback: OrchestratorBackend,
): OrchestratorBackend | null {
  const hasRoom = (backend: OrchestratorBackend) => loads[backend] < caps[backend];

  if (requested) {
    if (hasRoom(requested)) return requested;
    return hasRoom(fallback) ? fallback : null;
  }

  let best: OrchestratorBackend | null = null;
  for (const backend of BACKEND_TIE_ORDER) {
    if (!hasRoom(backend)) continue;
    if (best === null || loads[backend] < loads[best]) best = backend;
  }
  return best;
}
