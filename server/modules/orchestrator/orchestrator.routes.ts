import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { OrchestratorBackend } from '@/modules/database/index.js';
import type { JobCheckpointRollbackResult } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { JOB_KINDS, type JobsService, type OrchestratorJobKind } from './services/jobs.service.js';
import { formatMorphLine, formatMorphTable } from './services/morph-usage.service.js';
import type { MorphUsageService } from './services/morph-usage.service.js';
import type { StatusService } from './services/status.service.js';
import type { createMergeQueueService } from './services/merge-queue.service.js';
import type { HubWakeService } from './services/hub-wake.service.js';
import type { HubService } from './services/hub.service.js';
import { isOrchestratorToken } from './services/orchestrator-token.service.js';

const BACKENDS = ['claude', 'codex', 'glm', 'agy', 'zcode', 'morph'];

function readString(value: unknown, name: string, required: true): string;
function readString(value: unknown, name: string, required: false): string | null;
function readString(value: unknown, name: string, required: boolean): string | null {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed && required) {
    throw new AppError(`${name} is required`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return parsed || null;
}

function readKind(value: unknown): OrchestratorJobKind {
  const kind = readString(value, 'kind', false) ?? 'feature';
  if (!(JOB_KINDS as readonly string[]).includes(kind)) {
    throw new AppError('kind must be feature or bugfix', { code: 'INVALID_KIND', statusCode: 400 });
  }
  return kind as OrchestratorJobKind;
}

function readBackend(value: unknown): OrchestratorBackend | null {
  const backend = readString(value, 'backend', false);
  if (backend === null || backend === 'auto') return null;
  if (!BACKENDS.includes(backend)) {
    throw new AppError('backend must be claude, codex, glm, agy, zcode, morph or auto', { code: 'INVALID_BACKEND', statusCode: 400 });
  }
  return backend as OrchestratorBackend;
}

function readCheckpointTurn(value: unknown): number {
  const turn = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : NaN);
  if (!Number.isInteger(turn) || turn < 1) {
    throw new AppError('turn must be a checkpoint number (a positive integer)', {
      code: 'INVALID_CHECKPOINT_TURN',
      statusCode: 400,
    });
  }
  return turn;
}

/**
 * Builds the Orchestrator router. Local tools present the orchestrator token
 * (`Authorization: Bearer <token>`); the web app its usual login.
 */
export function createOrchestratorRouter(services: {
  jobs: JobsService;
  mergeQueue: ReturnType<typeof createMergeQueueService>;
  hubWake: HubWakeService;
  /** `tjob hub` / `tjob hub use` / `tjob hub new`: the hub session's status and switching. */
  hub: HubService;
  /** `tjob meter` and the `tjob ls` line: Morph Ultra's rolling usage against its caps. */
  morphUsage: MorphUsageService;
  /** `tjob status` and the web Status view: goals, jobs, capacity, hub and efficiency in one place. */
  status: StatusService;
  caps: () => Record<OrchestratorBackend, number>;
  authenticate: RequestHandler;
  /** `tjob rollback`: restore a job's worktree from a per-turn checkpoint (Worktrees module). */
  rollbackJobCheckpoint: (jobId: string, turn: number, options: { discardUntracked: boolean }) => Promise<JobCheckpointRollbackResult>;
}): express.Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;
    if (bearer && isOrchestratorToken(bearer)) {
      next();
      return;
    }
    services.authenticate(req, res, next);
  });

  router.get('/', asyncHandler(async (_req, res) => {
    const morphUsage = services.morphUsage.usage();
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({
      jobs: services.jobs.list(),
      loads: services.jobs.loads(),
      caps: services.caps(),
      backendStatus: services.jobs.backendStatus(),
      morphUsage,
      morphLine: formatMorphLine(morphUsage),
    }));
  }));

  // Before `/:id`, which would otherwise read "meter" as a job id.
  router.get('/meter', asyncHandler(async (_req, res) => {
    const usage = services.morphUsage.usage();
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({ usage, line: formatMorphLine(usage), table: formatMorphTable(usage) }));
  }));

  // Before `/:id`, which would otherwise read "status" as a job id.
  router.get('/status', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({ status: services.status.snapshot() }));
  }));

  // `tjob status --md`: the same snapshot as the STATUS.md rendering.
  router.get('/status.md', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/markdown').send(services.status.markdown());
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const job = await services.jobs.create({
      title: readString(body.title, 'title', true),
      prompt: readString(body.prompt, 'prompt', true),
      repoPath: readString(body.repo, 'repo', true),
      backend: readBackend(body.backend),
      model: readString(body.model, 'model', false),
      baseBranch: readString(body.base, 'base', false),
      kind: readKind(body.kind),
    });
    res.status(201).json(createApiSuccessResponse({ job }));
  }));

  router.post('/from-session', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const job = await services.jobs.createFromSession({
      sessionId: readString(body.sessionId, 'sessionId', true),
      content: readString(body.content, 'content', true),
      backend: readBackend(body.backend),
      repo: readString(body.repo, 'repo', false),
    });
    res.status(201).json(createApiSuccessResponse({ job }));
  }));

  // Before `/:id`, which would otherwise read "from-session" as a job id.
  router.get('/from-session/context', asyncHandler(async (req, res) => {
    const context = await services.jobs.fromSessionContext({
      sessionId: readString(req.query.sessionId, 'sessionId', true),
    });
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse(context));
  }));

  // Before `/:id`, which would otherwise read "hub" and "hub-wake" as job ids.
  router.get('/hub', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({ hub: services.hub.status() }));
  }));

  router.post('/hub/use', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hub = services.hub.useSession(readString(body.sessionId, 'sessionId', true));
    res.json(createApiSuccessResponse({ hub }));
  }));

  router.post('/hub/new', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = services.hub.createSession({
      provider: readString(body.provider, 'provider', true),
      model: readString(body.model, 'model', false),
      effort: readString(body.effort, 'effort', false),
      agent: readString(body.agent, 'agent', false),
      cwd: readString(body.cwd, 'cwd', false),
    });
    res.status(201).json(createApiSuccessResponse({ session }));
  }));

  router.post('/hub-wake', asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const isTest = body.test === true || body.test === 'true';
    const result = await services.hubWake.triggerWake({ test: isTest });
    if (!result.success) {
      throw new AppError(result.message, { code: 'HUB_DELIVERY_FAILED', statusCode: 502 });
    }
    res.json(createApiSuccessResponse(result));
  }));

  router.post('/cleanup', asyncHandler(async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    res.json(createApiSuccessResponse({ results: await services.jobs.sweepCleanup(dryRun) }));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const job = services.jobs.get(String(req.params.id));
    if (!job) throw new AppError('Job not found', { code: 'JOB_NOT_FOUND', statusCode: 404 });
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({ job }));
  }));

  router.post('/:id/done', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.markDone(String(req.params.id)) }));
  }));

  router.post('/:id/approve', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.approve(String(req.params.id)) }));
  }));

  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.cancel(String(req.params.id)) }));
  }));

  router.post('/:id/resume', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.resume(String(req.params.id)) }));
  }));

  router.post('/:id/rollback', asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const jobId = String(req.params.id);
    const rollback = await services.rollbackJobCheckpoint(jobId, readCheckpointTurn(body.turn), { discardUntracked: body.discardUntracked === true });
    res.json(createApiSuccessResponse({ rollback, job: services.jobs.get(jobId) }));
  }));

  router.post('/:id/retry', asyncHandler(async (req, res) => {
    const job = services.jobs.get(String(req.params.id));
    if (!job) throw new AppError('Job not found', { code: 'JOB_NOT_FOUND', statusCode: 404 });
    if (job.merge_step !== 'blocked') {
      throw new AppError(`Job ${job.id} is not blocked (${job.merge_step})`, { code: 'JOB_NOT_BLOCKED', statusCode: 409 });
    }
    services.mergeQueue.retry(job);
    res.json(createApiSuccessResponse({ job: services.jobs.get(job.id) }));
  }));

  return router;
}
