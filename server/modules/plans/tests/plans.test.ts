import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { createPlansRoutes } from '../plans.routes.js';
import { createPlansService } from '../plans.service.js';

const env = { TOKEN_URL: 'https://auth.example/token', TRIPAM_PLANS_CLIENT_ID: 'client', TRIPAM_PLANS_CLIENT_SECRET: 'service-secret', TRIPAM_API_URL: 'https://api.example' };

test('proxy caches tokens, allowlists readings, and never logs or returns secrets', async () => {
  let tokens = 0;
  const logs: unknown[][] = [];
  const previousLog = console.log, previousError = console.error;
  console.log = (...args) => { logs.push(args); }; console.error = (...args) => { logs.push(args); };
  const service = createPlansService(env, async (url, init) => {
    if (url === env.TOKEN_URL) {
      tokens++;
      assert.ok(String(init?.body).includes('grant_type=client_credentials'));
      return Response.json({ access_token: 'private-token', expires_in: 3600 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-token');
    return Response.json([
      { plan: 'claude', token: 'private-token', note: 'private-token service-secret', at: '2026-10-23T12:00:00Z', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 30, resetsAt: null, secret: 'private-token' }] },
      { plan: 'zai', at: '2026-10-23T12:00:00Z', windows: [{ id: 'zai-5h', label: '5 hours', usedPercent: 64, resetsAt: '2026-10-24T10:00:00Z' }, { id: 'zai-week', label: 'Week', usedPercent: 12, resetsAt: '2026-10-26T00:00:00Z' }] },
      { plan: 'other', at: '2026-10-23T12:00:00Z', windows: [] },
    ]);
  });
  const app = express();
  // Same mount order as the real server: authentication precedes all plans routes.
  app.use('/api/plans', (req, res, next) => req.headers.authorization === 'Bearer local-session' ? next() : res.sendStatus(401), createPlansRoutes(service));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/plans`;
  try {
    assert.equal((await fetch(`${base}/usage`)).status, 401);
    {
      const response = await fetch(`${base}/usage`, { headers: { Authorization: 'Bearer local-session' } });
      assert.equal(response.status, 200);
      const readings = await response.json() as Array<{ plan: string; windows: Array<{ id: string | null; label: string | null; usedPercent: number | null; resetsAt: string | null }> }>;
      assert.deepEqual(readings.map((reading) => reading.plan), ['claude', 'zai']);
      const zai = readings[1];
      assert.deepEqual(zai.windows, [
        { id: 'zai-5h', label: '5 hours', usedPercent: 64, resetsAt: '2026-10-24T10:00:00Z' },
        { id: 'zai-week', label: 'Week', usedPercent: 12, resetsAt: '2026-10-26T00:00:00Z' },
      ]);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const suffix of ['/usage', '/usage/history?plan=zai&days=7']) {
      const response = await fetch(base + suffix, { headers: { Authorization: 'Bearer local-session' } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(!body.includes('private-token')); assert.ok(!body.includes('service-secret'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(tokens, 1);
    assert.equal((await fetch(`${base}/usage/history?plan=other`, { headers: { Authorization: 'Bearer local-session' } })).status, 400);
    assert.ok(!JSON.stringify(logs).includes('private-token')); assert.ok(!JSON.stringify(logs).includes('service-secret'));
  } finally { console.log = previousLog; console.error = previousError; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('missing configuration does not request a token', async () => {
  const service = createPlansService({}, async () => { throw new Error('unexpected'); });
  assert.equal(service.configured(), false);
});

test('upstream errors never propagate credentials', async () => {
  const service = createPlansService(env, async () => { throw new Error('service-secret'); });
  const app = express(); app.use(createPlansRoutes(service));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as {port: number}).port}/usage`);
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'Plans usage unavailable' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('expired credentials are refreshed rather than reused', async () => {
  let tokens = 0;
  const service = createPlansService(env, async (url) => {
    if (url === env.TOKEN_URL) { tokens++; return Response.json({ access_token: `private-${tokens}`, expires_in: 1 }); }
    return Response.json([]);
  });
  await service.read(); await service.read();
  assert.equal(tokens, 2);
});

test('concurrent requests share a token exchange', async () => {
  let tokens = 0;
  const service = createPlansService(env, async (url) => {
    if (url === env.TOKEN_URL) { tokens++; return Response.json({ access_token: 'shared-private-token', expires_in: 3600 }); }
    return Response.json([]);
  });
  await Promise.all([service.read(), service.read('claude'), service.read('google')]);
  assert.equal(tokens, 1);
});
