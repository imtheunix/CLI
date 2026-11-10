import type { RequestHandler } from 'express';

import { orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';
import { reattachActiveTurns } from '@/modules/detached-turns/index.js';
import { rollbackJobCheckpoint, runGitCommand } from '@/modules/worktrees/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';

import { createOrchestratorRouter } from './orchestrator.routes.js';
import { getEffectOutbox } from './services/effect-outbox.service.js';
import { createHubService } from './services/hub.service.js';
import { createJobsService } from './services/jobs.service.js';
import { createMergeQueueService } from './services/merge-queue.service.js';
import { createMorphUsageService } from './services/morph-usage.service.js';
import { createRefuteService } from './services/refute.service.js';
import { createReviewService } from './services/review.service.js';
import { createHubWakeService } from './services/hub-wake.service.js';
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
  const morphUsage = createMorphUsageService({ config });
  const refuteService = createRefuteService({ runtime: input.runtime, config });
  const jobs = createJobsService({
    runtime: input.runtime,
    config,
    morphUsage,
    abortRefutation: (job) => refuteService.abort(job),
  });
  const review = createReviewService({ jobs, config, refuteService });
  const mergeQueue = createMergeQueueService({ jobs, config });
  const hubWake = createHubWakeService({ runtime: input.runtime, config });
  const hub = createHubService({ config });
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await jobs.tick();
      void review.tick();
      void mergeQueue.tick();
      await hubWake.tick();
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
      hubWake,
      hub,
      morphUsage,
      authenticate: input.authenticate,
      caps: () => {
        const { backends } = config();
        return Object.fromEntries(Object.entries(backends).map(([name, backend]) => [name, backend.cap])) as Record<OrchestratorBackend, number>;
      },
      // `tjob rollback <id> <turn> [--discard-untracked]`: restore a job's worktree from a
      // per-turn checkpoint; refuses while the job's session is doing anything. Recorded in
      // the effect outbox (process-bound: a restart never replays a half-done rollback).
      rollbackJobCheckpoint: async (jobId, turn, options) => {
        const ran = await getEffectOutbox().run(
          { key: `rollback:${jobId}:${turn}@${new Date().toISOString()}`, jobId, kind: 'rollback', replay: 'process_bound', payload: { turn, discardUntracked: options.discardUntracked } },
          () => rollbackJobCheckpoint(
            { jobId, turn, discardUntracked: options.discardUntracked },
            {
              runGit: runGitCommand,
              getJob: (id) => orchestratorJobsDb.get(id),
              isJobRunning: (job: OrchestratorJobRow) =>
                job.state === 'preparing' || job.in_turn === 1 ||
                Boolean(job.session_id && (chatRunRegistry.isProcessing(job.session_id) || input.runtime.hasBackgroundWork(job.session_id))),
            },
          ),
        );
        if (ran.status !== 'ran') {
          throw new AppError(`Rollback of job ${jobId} skipped (${ran.reason})`, { code: 'ROLLBACK_SKIPPED', statusCode: 409 });
        }
        return ran.value;
      },
    }),

    async start(): Promise<void> {
      getOrchestratorToken();
      hubWake.start();
      unsubscribe = chatRunRegistry.onRunCompleted((completion) => jobs.handleRunCompleted(completion));
      await reattachActiveTurns({
        onTurnCompleted: (turn, exitCode) => {
          if (turn.job_id) {
            jobs.handleRunCompleted({ appSessionId: turn.session_id, exitCode, aborted: false });
          }
        },
      }).catch((error) => console.error('[DetachedTurns] Reattach failed', error));
      // The outbox before anything new runs: safe effects the old process left are replayed once, process-bound
      // ones dropped (a re-attached turn is kept), failed undos retried; a job whose undo still fails keeps its rows held.
      await getEffectOutbox().recover({ ...jobs.effectHandlers(), ...mergeQueue.effectHandlers() }, (row) => jobs.adoptEffect(row))
        .then((report) => {
          if (report.replayed.length + report.dropped.length + report.failed.length + report.adopted.length + report.held.length > 0) {
            console.log(`[Orchestrator] Effect outbox after restart: ${report.replayed.length} replayed, ${report.adopted.length} adopted, ${report.dropped.length} dropped, ${report.failed.length} failed, ${report.held.length} held by a failed undo`);
          }
        })
        .catch((error) => console.error('[Orchestrator] Effect outbox recovery failed', error));
      await jobs.recover().catch((error) => console.error('[Orchestrator] Recovery failed', error));
      timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      hubWake.stop();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
