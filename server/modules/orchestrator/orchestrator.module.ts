import type { RequestHandler } from 'express';

import type { OrchestratorBackend } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

import { createOrchestratorRouter } from './orchestrator.routes.js';
import { createJobsService } from './services/jobs.service.js';
import { createMergeQueueService } from './services/merge-queue.service.js';
import { loadOrchestratorConfig } from './services/orchestrator-config.service.js';
import { getOrchestratorToken } from './services/orchestrator-token.service.js';

/** How often the balancer and the CI/CD queue look at their jobs. */
const TICK_INTERVAL_MS = 3_000;

/**
 * Used by the server entrypoint: the Orchestrator's router plus the loop that
 * balances jobs over Claude, GPT and GLM and moves finished ones through the
 * CI/CD queue. `start` runs after the server listens, and resumes whatever a
 * restart interrupted.
 */
export function createOrchestratorModule(input: { runtime: ProviderRuntimeGateway; authenticate: RequestHandler }) {
  const config = () => loadOrchestratorConfig();
  const jobs = createJobsService({ runtime: input.runtime, config });
  const mergeQueue = createMergeQueueService({ jobs, config });
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await jobs.tick();
      void mergeQueue.tick();
    } catch (error) {
      console.error('[Orchestrator] Tick failed', error);
    } finally {
      ticking = false;
    }
  };

  return {
    router: createOrchestratorRouter({
      jobs,
      mergeQueue,
      authenticate: input.authenticate,
      caps: () => {
        const { backends } = config();
        return Object.fromEntries(Object.entries(backends).map(([name, backend]) => [name, backend.cap])) as Record<OrchestratorBackend, number>;
      },
    }),

    async start(): Promise<void> {
      getOrchestratorToken();
      unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
      await jobs.recover().catch((error) => console.error('[Orchestrator] Recovery failed', error));
      timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
