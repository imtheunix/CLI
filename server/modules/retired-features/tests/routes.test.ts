import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createRetiredFeatureRoutes } from '../index.js';

test('retired endpoints return JSON 404 before the SPA fallback for every verb', async () => {
  const app = express(); app.use('/api', createRetiredFeatureRoutes()); app.use((_req, res) => res.send('SPA'));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const path of ['/git/status', '/worktrees/create', '/system/update', '/file-tree/projects/demo/files/create', '/file-tree/projects/demo/files/rename', '/file-tree/projects/demo/files/upload']) {
        const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${path}`, { method });
        assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Feature removed' });
      }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
