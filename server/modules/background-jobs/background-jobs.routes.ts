import { Router } from 'express';
import { createBackgroundJobsService } from './background-jobs.service.js';

/** Mounted by the server entrypoint behind authentication; offers read-only job discovery. */
export function createBackgroundJobsRoutes(service = createBackgroundJobsService()) {
  const router = Router();
  router.get('/', async (_req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json({ jobs: await service.list() }); }
    catch (error) { next(error); }
  });
  router.get('/:id', async (req, res) => {
    try {
      const detail = await service.detail(req.params.id);
      if (!detail) { res.status(404).json({ error: 'Job not found' }); return; }
      res.set('Cache-Control', 'no-store').json(detail);
    } catch { res.status(422).json({ error: 'Job output unavailable or path not allowed' }); }
  });
  return router;
}
