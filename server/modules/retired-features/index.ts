import { Router } from 'express';

/** Used by the server entrypoint to disable retired feature endpoints before the SPA fallback. */
export function createRetiredFeatureRoutes() {
  const router = Router();
  router.use(['/git', '/worktrees', '/system'], (_req, res) => { res.status(404).json({ error: 'Feature removed' }); });
  router.all(['/file-tree/projects/:projectId/files/create', '/file-tree/projects/:projectId/files/rename', '/file-tree/projects/:projectId/files/upload'], (_req, res) => { res.status(404).json({ error: 'Feature removed' }); });
  router.delete('/file-tree/projects/:projectId/files', (_req, res) => { res.status(404).json({ error: 'Feature removed' }); });
  return router;
}
