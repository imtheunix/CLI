import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { OrchestratorBackend } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import { createOrchestratorRouter } from '@/modules/orchestrator/orchestrator.routes.js';
import { createHubService } from '@/modules/orchestrator/services/hub.service.js';
import { createMorphUsageService } from '@/modules/orchestrator/services/morph-usage.service.js';
import { loadOrchestratorConfig } from '@/modules/orchestrator/services/orchestrator-config.service.js';
import type { OrchestratorConfig } from '@/modules/orchestrator/services/orchestrator-config.service.js';

import type { createJobsService } from '../services/jobs.service.js';
import type { createMergeQueueService } from '../services/merge-queue.service.js';
import type { createHubWakeService } from '../services/hub-wake.service.js';

type JobsService = ReturnType<typeof createJobsService>;
type MergeQueueService = ReturnType<typeof createMergeQueueService>;
type HubWakeService = ReturnType<typeof createHubWakeService>;

const unexpected = async (): Promise<never> => {
  throw new Error('Unexpected orchestrator service call');
};

/** Jobs/merge-queue/hub-wake stubs: these routes only touch the hub service. */
function fakeHeavyServices(): { jobs: JobsService; mergeQueue: MergeQueueService; hubWake: HubWakeService } {
  return {
    jobs: { loads: () => ({}) } as unknown as JobsService,
    mergeQueue: { retry: unexpected } as unknown as MergeQueueService,
    hubWake: { triggerWake: unexpected } as unknown as HubWakeService,
  };
}

const passAuth: RequestHandler = (_req, _res, next) => next();

/** The production error middleware's AppError shape, so refusals come back as JSON. */
const errorMiddleware = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  next(err);
};

async function withHubServer(
  run: (input: { baseUrl: string; config: () => OrchestratorConfig; configFile: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'orchestrator-hub-'));
  const configFile = path.join(root, 'orchestrator.json');
  // An existing hub entry with extra fields: switching must keep them.
  await writeFile(configFile, JSON.stringify({ hub: { sessionId: '', wake: false, debounceSec: 42 }, review: true }));

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await writeFile(path.join(root, 'auth.db'), '');
  await initializeDatabase();

  const config = () => loadOrchestratorConfig(configFile);
  const app = express();
  app.use(express.json());
  app.use('/api/orchestrator', createOrchestratorRouter({
    ...fakeHeavyServices(),
    hub: createHubService({ config, configFile }),
    morphUsage: createMorphUsageService({
      config,
      ledgerPath: path.join(root, 'no-ledger.jsonl'),
      databasePath: path.join(root, 'no-opencode.db'),
    }),
    caps: () => Object.fromEntries(Object.entries(config().backends).map(([name, backend]) => [name, backend.cap])) as Record<OrchestratorBackend, number>,
    authenticate: passAuth,
    rollbackJobCheckpoint: unexpected,
  }));
  app.use(errorMiddleware);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, config, configFile });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

async function post(baseUrl: string, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/orchestrator${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  assert.equal(body.success, true, JSON.stringify(body));
  return body.data as Record<string, unknown>;
}

function errorOf(status: number, body: Record<string, unknown>): { status: number; code: string; message: string } {
  assert.equal(body.success, false, JSON.stringify(body));
  const error = body.error as { code: string; message: string };
  return { status, code: error.code, message: error.message };
}

test('tjob hub routes: new creates a hub-capable session without switching, use switches and keeps fields', async () => {
  await withHubServer(async ({ baseUrl, configFile }) => {
    // No hub configured yet: status says so.
    let get = await fetch(`${baseUrl}/api/orchestrator/hub`);
    let payload = dataOf(await get.json() as Record<string, unknown>) as { hub: Record<string, unknown> };
    assert.equal(get.status, 200);
    assert.equal(payload.hub.sessionId, null);

    // `tjob hub new --provider opencode --model morph/morph-kimik31 --effort low --agent morph-hub`
    const created = await post(baseUrl, '/hub/new', {
      provider: 'opencode',
      model: 'morph/morph-kimik31',
      effort: 'low',
      agent: 'morph-hub',
      cwd: tmpdir(),
    });
    assert.equal(created.status, 201);
    const session = (dataOf(created.body) as { session: Record<string, unknown> }).session;
    assert.equal(session.provider, 'opencode');
    assert.equal(session.model, 'morph/morph-kimik31');
    assert.equal(session.effort, 'low');
    assert.equal(session.agent, 'morph-hub');
    assert.equal(session.customName, 'Hub · morph-kimik31');

    const row = sessionsDb.getSessionById(String(session.sessionId));
    assert.ok(row);
    assert.equal(row.provider, 'opencode');
    assert.equal(row.model, 'morph/morph-kimik31');
    assert.equal(row.effort, 'low');
    assert.equal(row.agent, 'morph-hub');

    // Creating never switches: the hub is still unset.
    get = await fetch(`${baseUrl}/api/orchestrator/hub`);
    payload = dataOf(await get.json() as Record<string, unknown>) as { hub: Record<string, unknown> };
    assert.equal(payload.hub.sessionId, null);

    // `tjob hub use <sessionId>`
    const used = await post(baseUrl, '/hub/use', { sessionId: session.sessionId });
    assert.equal(used.status, 200);
    const hub = (dataOf(used.body) as { hub: Record<string, unknown> }).hub;
    assert.equal(hub.sessionId, session.sessionId);
    assert.equal(hub.provider, 'opencode');
    assert.equal(hub.model, 'morph/morph-kimik31');
    assert.equal(hub.effort, 'low');
    assert.equal(hub.agent, 'morph-hub');
    assert.equal(hub.wake, false, 'the existing wake: false is kept');

    // The config file keeps the unrelated hub fields and the rest of the file.
    const raw = JSON.parse(await readFile(configFile, 'utf8')) as { hub: Record<string, unknown>; review?: boolean };
    assert.equal(raw.hub.sessionId, session.sessionId);
    assert.equal(raw.hub.debounceSec, 42);
    assert.equal(raw.review, true);

    // GET /hub reflects the switch.
    get = await fetch(`${baseUrl}/api/orchestrator/hub`);
    payload = dataOf(await get.json() as Record<string, unknown>) as { hub: Record<string, unknown> };
    assert.equal(payload.hub.sessionId, session.sessionId);
    assert.equal(payload.hub.agent, 'morph-hub');
  });
});

test('tjob hub use refuses an unknown session; hub/new refuses an unknown provider and a missing cwd', async () => {
  await withHubServer(async ({ baseUrl }) => {
    const missing = await post(baseUrl, '/hub/use', { sessionId: 'no-such-session' });
    assert.deepEqual(errorOf(missing.status, missing.body), { status: 404, code: 'HUB_SESSION_NOT_FOUND', message: 'Session "no-such-session" was not found' });

    const provider = await post(baseUrl, '/hub/new', { provider: 'morphware' });
    assert.equal(errorOf(provider.status, provider.body).status, 400);
    assert.equal(errorOf(provider.status, provider.body).code, 'UNSUPPORTED_PROVIDER');

    const cwd = await post(baseUrl, '/hub/new', { provider: 'opencode', cwd: '/no/such/dir' });
    assert.equal(errorOf(cwd.status, cwd.body).code, 'HUB_CWD_NOT_FOUND');

    const noProvider = await post(baseUrl, '/hub/new', {});
    assert.equal(errorOf(noProvider.status, noProvider.body).code, 'INVALID_REQUEST_BODY');
  });
});

test('tjob hub use refuses to rewrite an invalid orchestrator.json instead of dropping its settings', async () => {
  await withHubServer(async ({ baseUrl, configFile }) => {
    const created = await post(baseUrl, '/hub/new', { provider: 'opencode', model: 'morph/morph-kimik31', cwd: tmpdir() });
    const session = (dataOf(created.body) as { session: Record<string, unknown> }).session;

    const broken = '{ "backends": { "glm": { "cap": 3 } }, "hub": ';
    await writeFile(configFile, broken);
    const used = await post(baseUrl, '/hub/use', { sessionId: session.sessionId });
    const error = errorOf(used.status, used.body);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'HUB_CONFIG_INVALID');
    assert.equal(await readFile(configFile, 'utf8'), broken, 'the file is left as it was');
  });
});

test('tjob meter: GET /meter and the ls line report both Morph groups against their caps', async () => {
  await withHubServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/orchestrator/meter`);
    const data = dataOf(await response.json() as Record<string, unknown>) as {
      usage: { source: string; groups: Record<string, { caps: { uncachedIn: number; out: number } }> };
      line: string;
      table: string;
    };
    assert.equal(response.status, 200);
    assert.equal(data.usage.source, 'none');
    assert.deepEqual(data.usage.groups.kimi.caps, { uncachedIn: 72_870, out: 6_162 });
    assert.deepEqual(data.usage.groups.deepseek.caps, { uncachedIn: 2_103_237, out: 76_559 });
    assert.equal(data.line, 'morph: kimi out 0/6.2k in 0/72.9k | deepseek out 0/76.6k in 0/2.1M');
    assert.match(data.table, /morph usage \(none,/);
  });
});
