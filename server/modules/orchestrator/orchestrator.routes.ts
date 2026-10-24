import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { OrchestratorBackend } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { JobsService } from './services/jobs.service.js';
import type { createMergeQueueService } from './services/merge-queue.service.js';
import { isOrchestratorToken } from './services/orchestrator-token.service.js';

const BACKENDS = ['claude', 'codex', 'glm'];

function readString(value: unknown, name: string, required: true): string;
function readString(value: unknown, name: string, required: false): string | null;
function readString(value: unknown, name: string, required: boolean): string | null {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed && required) {
    throw new AppError(`${name} is required`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return parsed || null;
}

function readBackend(value: unknown): OrchestratorBackend | null {
  const backend = readString(value, 'backend', false);
  if (backend === null || backend === 'auto') return null;
  if (!BACKENDS.includes(backend)) {
    throw new AppError('backend must be claude, codex, glm or auto', { code: 'INVALID_BACKEND', statusCode: 400 });
  }
  return backend as OrchestratorBackend;
}

/**
 * Builds the Orchestrator router. Local tools present the orchestrator token
 * (`Authorization: Bearer <token>`); the web app its usual login.
 */
export function createOrchestratorRouter(services: {
  jobs: JobsService;
  mergeQueue: ReturnType<typeof createMergeQueueService>;
  caps: () => Record<OrchestratorBackend, number>;
  authenticate: RequestHandler;
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
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({
      jobs: services.jobs.list(),
      loads: services.jobs.loads(),
      caps: services.caps(),
    }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const job = await services.jobs.create({
      title: readString(body.title, 'title', true),
      prompt: readString(body.prompt, 'prompt', true),
      repoPath: readString(body.repo, 'repo', true),
      backend: readBackend(body.backend),
      baseBranch: readString(body.base, 'base', false),
    });
    res.status(201).json(createApiSuccessResponse({ job }));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const job = services.jobs.get(String(req.params.id));
    if (!job) throw new AppError('Job not found', { code: 'JOB_NOT_FOUND', statusCode: 404 });
    res.set('Cache-Control', 'no-store').json(createApiSuccessResponse({ job }));
  }));

  router.post('/:id/done', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.markDone(String(req.params.id)) }));
  }));

  router.post('/:id/resume', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse({ job: await services.jobs.resume(String(req.params.id)) }));
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
