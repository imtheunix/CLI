import { Router } from 'express';
import { createPlansService } from './plans.service.js';

/** Used by the server entrypoint behind its own authentication and by route tests. */
export function createPlansRoutes(service = createPlansService()) {
  const router = Router();
  router.get(['/usage', '/usage/history'], async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!service.configured()) { res.json({ configured: false }); return; }
    const history = req.path.endsWith('/history');
    const plan = typeof req.query.plan === 'string' ? req.query.plan : undefined;
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    if (history && (!plan || !['claude', 'chatgpt', 'google'].includes(plan) || !Number.isInteger(days) || days < 1 || days > 90)) {
      res.status(400).json({ error: 'Invalid plan or days (1–90)' }); return;
    }
    try { res.json(await service.read(history ? plan : undefined, days)); }
    catch { res.status(502).json({ error: 'Plans usage unavailable' }); }
  });
  return router;
}
