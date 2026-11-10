import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fsp from 'node:fs/promises';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { LabsProvider, type LabsRequestRecord } from '../list/labs/labs.provider.js';

type FakeServerOptions = {
  requests?: LabsRequestRecord[];
  status?: number;
  authError?: boolean;
};

function createFakeControlRoom(options: FakeServerOptions = {}) {
  let rows = options.requests ? [...options.requests] : [];
  let status = options.status ?? 200;
  let authError = options.authError ?? false;
  const queriesReceived: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    queriesReceived.push({ url: req.url || '/', headers: req.headers });

    if (authError || status === 401) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sign in first' }));
      return;
    }

    if (reqUrl.pathname === '/api/llm/requests') {
      const limit = parseInt(reqUrl.searchParams.get('limit') || '200', 10);
      const since = reqUrl.searchParams.get('since') ? parseFloat(reqUrl.searchParams.get('since')!) : null;
      const before = reqUrl.searchParams.get('before') ? parseInt(reqUrl.searchParams.get('before')!, 10) : null;

      let filtered = rows;
      if (since !== null) {
        filtered = filtered.filter((r) => r.at >= since);
      }
      if (before !== null) {
        filtered = filtered.filter((r) => r.id < before);
      }

      // Newest first
      filtered.sort((a, b) => (b.at === a.at ? b.id - a.id : b.at - a.at));
      const paged = filtered.slice(0, limit);

      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(paged));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return {
    server,
    queriesReceived,
    setRows(newRows: LabsRequestRecord[]) {
      rows = [...newRows];
    },
    addRow(row: LabsRequestRecord) {
      rows.push(row);
    },
    setStatus(s: number) {
      status = s;
    },
    setAuthError(val: boolean) {
      authError = val;
    },
    listen(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-provider-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  // Prevent the connection bootstrap from copying the checkout's legacy database.
  await fsp.writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fsp.rm(tempDirectory, { recursive: true, force: true });
  }
}

test('LabsProvider groups records by (source, caller, instance) or (source, caller, day)', async () => {
  await withIsolatedDatabase(async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-grouping-'));
    // Deliberately cross UTC midnight, safely inside the provider's 30-day window.
    const fixtureTime = new Date();
    fixtureTime.setUTCDate(fixtureTime.getUTCDate() - 2);
    fixtureTime.setUTCHours(23, 58, 0, 0);
    const baseSec = fixtureTime.getTime() / 1000;
    const fakeServer = createFakeControlRoom({
      requests: [
        {
          id: 1,
          at: baseSec,
          source: '3beira-workers',
          caller: 'workflow',
          instance: 'inst-alpha',
          node: 'step_1',
          step: 'execute',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 1.25,
          prompt_tokens: 1000,
          completion_tokens: 200,
          cost: 0.0005,
        },
        {
          id: 2,
          at: baseSec + 180,
          source: '3beira-workers',
          caller: 'workflow',
          instance: 'inst-alpha',
          node: 'step_2',
          step: 'review',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 2.1,
          prompt_tokens: 1500,
          completion_tokens: 350,
          cost: 0.0008,
        },
        {
          id: 3,
          at: baseSec + 300,
          source: 'lab',
          caller: null,
          instance: null,
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 0.8,
          prompt_tokens: 500,
          completion_tokens: 100,
          cost: 0.0002,
        },
        {
          id: 4,
          at: baseSec + 400,
          source: '3beira-workers',
          caller: 'planner',
          instance: null,
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 1.5,
          prompt_tokens: 800,
          completion_tokens: 150,
          cost: 0.0004,
        },
      ],
    });

    try {
      const baseUrl = await fakeServer.listen();
      const provider = new LabsProvider({
        baseUrl,
        storageDir: tempDir,
        pollIntervalMs: 0,
      });

      const updatedCount = await provider.sessionSynchronizer.synchronize();
      assert.equal(updatedCount, 3);

      const outsideWorkflowDay = new Date((baseSec + 300) * 1000).toISOString().slice(0, 10);
      assert.notEqual(outsideWorkflowDay, fixtureTime.toISOString().slice(0, 10));

      // 1. Check workflow instance session
      const workflowSession = sessionsDb.getSessionByProviderSessionId('labs:3beira-workers:workflow:inst-alpha');
      assert.ok(workflowSession);
      assert.equal(workflowSession.provider, 'labs');
      assert.equal(workflowSession.custom_name, '3beira-workers/workflow (inst-alpha)');
      assert.equal(workflowSession.project_path, 'LABS agents');
      assert.equal(new Date(workflowSession.created_at).getTime(), baseSec * 1000);
      assert.equal(new Date(workflowSession.updated_at).getTime(), (baseSec + 180) * 1000);

      // 2. Check lab outside-workflow session (no instance, no caller -> source (day))
      const labSession = sessionsDb.getSessionByProviderSessionId(`labs:lab::${outsideWorkflowDay}`);
      assert.ok(labSession);
      assert.equal(labSession.provider, 'labs');
      assert.equal(labSession.custom_name, `lab (${outsideWorkflowDay})`);
      assert.equal(labSession.project_path, 'LABS agents');
      assert.equal(new Date(labSession.created_at).getTime(), (baseSec + 300) * 1000);
      assert.equal(new Date(labSession.updated_at).getTime(), (baseSec + 300) * 1000);

      // 3. Check 3beira-workers/planner outside-workflow session
      const plannerSession = sessionsDb.getSessionByProviderSessionId(`labs:3beira-workers:planner:${outsideWorkflowDay}`);
      assert.ok(plannerSession);
      assert.equal(plannerSession.provider, 'labs');
      assert.equal(plannerSession.custom_name, `3beira-workers/planner (${outsideWorkflowDay})`);
      assert.equal(plannerSession.project_path, 'LABS agents');
      assert.equal(new Date(plannerSession.created_at).getTime(), (baseSec + 400) * 1000);
      assert.equal(new Date(plannerSession.updated_at).getTime(), (baseSec + 400) * 1000);
    } finally {
      await fakeServer.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('LabsProvider incremental sync processes 0 unchanged rows and indexes a new row once', async () => {
  await withIsolatedDatabase(async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-incremental-'));
    const baseSec = Math.floor(Date.now() / 1000) - 1800; // 30 min ago
    const fakeServer = createFakeControlRoom({
      requests: [
        {
          id: 10,
          at: baseSec,
          source: '3beira-workers',
          caller: 'workflow',
          instance: 'inst-beta',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 1.0,
        },
      ],
    });

    try {
      const baseUrl = await fakeServer.listen();
      const provider = new LabsProvider({
        baseUrl,
        storageDir: tempDir,
        pollIntervalMs: 0,
      });

      // Initial sync bootstraps the 30-day window.
      const firstCount = await provider.sessionSynchronizer.synchronize();
      assert.equal(firstCount, 1);
      assert.equal(fakeServer.queriesReceived.length, 1);

      // A repeat sync re-reads only the cursor tail and re-upserts nothing.
      const secondCount = await provider.sessionSynchronizer.synchronize();
      assert.equal(secondCount, 0);
      assert.equal(fakeServer.queriesReceived.length, 2);
      const secondSince = Number(new URL(fakeServer.queriesReceived[1].url, 'http://x').searchParams.get('since'));
      assert.ok(secondSince > baseSec, 'the second scan starts from the persisted cursor, not the 30-day window');

      // A genuinely new row (current time) is indexed exactly once.
      const newRowAt = Math.floor(Date.now() / 1000);
      fakeServer.addRow({
        id: 11,
        at: newRowAt,
        source: '3beira-workers',
        caller: 'workflow',
        instance: 'inst-beta',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash',
        status: 200,
        seconds: 1.5,
      });

      const thirdCount = await provider.sessionSynchronizer.synchronize();
      assert.equal(thirdCount, 1);

      const session = sessionsDb.getSessionByProviderSessionId('labs:3beira-workers:workflow:inst-beta');
      assert.ok(session);
      assert.equal(new Date(session.updated_at).getTime(), newRowAt * 1000);

      const fourthCount = await provider.sessionSynchronizer.synchronize();
      assert.equal(fourthCount, 0, 'the same row is not re-upserted on the next scan');

      // Verify transcript holds both calls
      const history = await provider.sessions.fetchHistory('labs:3beira-workers:workflow:inst-beta');
      // 1 totals message + 2 call messages = 3 messages
      assert.equal(history.total, 3);
    } finally {
      await fakeServer.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('LabsProvider cursor survives a provider restart and does not refetch the bootstrap window', async () => {
  await withIsolatedDatabase(async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-restart-'));
    const baseSec = Math.floor(Date.now() / 1000) - 1800;
    const fakeServer = createFakeControlRoom({
      requests: [
        {
          id: 20,
          at: baseSec,
          source: '3beira-workers',
          caller: 'workflow',
          instance: 'inst-restart',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          status: 200,
          seconds: 1.0,
        },
      ],
    });

    try {
      const baseUrl = await fakeServer.listen();
      const firstProvider = new LabsProvider({ baseUrl, storageDir: tempDir, pollIntervalMs: 0 });
      assert.equal(await firstProvider.sessionSynchronizer.synchronize(), 1);

      // A fresh instance stands in for a process restart: the in-memory state
      // is gone, but the persisted cursor and transcripts are not.
      const restartedProvider = new LabsProvider({ baseUrl, storageDir: tempDir, pollIntervalMs: 0 });
      assert.equal(await restartedProvider.sessionSynchronizer.synchronize(), 0);

      const restartSince = Number(
        new URL(fakeServer.queriesReceived[1].url, 'http://x').searchParams.get('since'),
      );
      assert.ok(restartSince > baseSec, 'the restarted provider resumes from the persisted cursor');
    } finally {
      await fakeServer.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('LabsProvider failed scans reject instead of silently advancing the cursor', async () => {
  await withIsolatedDatabase(async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-failure-'));
    const fakeServer = createFakeControlRoom({ status: 500 });

    try {
      const baseUrl = await fakeServer.listen();
      const provider = new LabsProvider({ baseUrl, storageDir: tempDir, pollIntervalMs: 0 });

      await assert.rejects(
        () => provider.sessionSynchronizer.synchronize(),
        /LABS request failed with status 500/,
      );
      assert.equal(
        await fsp.readdir(tempDir).then((names) => names.includes('.labs-sync-cursor')),
        false,
        'a failed scan must not persist a cursor',
      );
    } finally {
      await fakeServer.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('LabsProvider fetchHistory renders timeline of metadata messages and totals at top', async () => {
  await withIsolatedDatabase(async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-history-'));
    const baseSec = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const fakeServer = createFakeControlRoom({
      requests: [
        {
          id: 101,
          at: baseSec,
          source: '3beira-workers',
          caller: 'agent',
          instance: 'inst-render',
          node: 'node_alpha',
          step: 'step_init',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash',
          role: 'planner',
          status: 200,
          seconds: 2.34,
          prompt_tokens: 1200,
          cached_tokens: 300,
          completion_tokens: 450,
          reasoning_tokens: 80,
          cost: 0.0012,
          retries: 0,
          fallback_reason: null,
        },
        {
          id: 102,
          at: baseSec + 50,
          source: '3beira-workers',
          caller: 'agent',
          instance: 'inst-render',
          node: 'node_beta',
          step: 'step_exec',
          model: 'deepseek-ai/DeepSeek-V4-Pro',
          role: 'executor',
          status: 502,
          seconds: 4.1,
          prompt_tokens: 2000,
          cached_tokens: 0,
          completion_tokens: 0,
          reasoning_tokens: 0,
          cost: 0.0,
          retries: 2,
          fallback_reason: 'DeepInfra timeout -> openrouter',
          error: 'Bad Gateway: DeepInfra upstream timeout',
        },
      ],
    });

    try {
      const baseUrl = await fakeServer.listen();
      const provider = new LabsProvider({
        baseUrl,
        storageDir: tempDir,
        pollIntervalMs: 0,
      });

      await provider.sessionSynchronizer.synchronize();

      const history = await provider.sessions.fetchHistory('labs:3beira-workers:agent:inst-render');
      assert.equal(history.total, 3);
      assert.equal(history.messages.length, 3);

      // Message 0: Totals at top
      const totalsMsg = history.messages[0];
      assert.equal(totalsMsg.role, 'assistant');
      assert.equal(totalsMsg.provider, 'labs');
      assert.ok(totalsMsg.content?.includes('LABS Timeline Totals'));
      assert.ok(totalsMsg.content?.includes('**Calls:** 2'));
      assert.ok(totalsMsg.content?.includes('**Cost:** $0.0012'));
      assert.ok(totalsMsg.content?.includes('prompt: 3,200'));

      // Message 1: First call
      const call1 = history.messages[1];
      assert.equal(call1.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
      assert.ok(call1.content?.includes('planner'));
      assert.ok(call1.content?.includes('node_alpha / step_init'));
      assert.ok(call1.content?.includes('prompt: 1200 (cached: 300)'));
      assert.ok(call1.content?.includes('completion: 450 (reasoning: 80)'));
      assert.ok(call1.content?.includes('**Cost:** $0.0012'));
      assert.ok(call1.content?.includes('**Status:** 200'));
      assert.ok(call1.content?.includes('**Latency:** 2.34s'));
      assert.ok(call1.content?.includes('0 retries'));

      // Message 2: Second call (with error and fallback)
      const call2 = history.messages[2];
      assert.equal(call2.model, 'deepseek-ai/DeepSeek-V4-Pro');
      assert.ok(call2.content?.includes('executor'));
      assert.ok(call2.content?.includes('node_beta / step_exec'));
      assert.ok(call2.content?.includes('**Status:** 502'));
      assert.ok(call2.content?.includes('2 retries, fallback: DeepInfra timeout -> openrouter'));
      assert.ok(call2.content?.includes('Bad Gateway: DeepInfra upstream timeout'));

      // Test pagination
      const page = await provider.sessions.fetchHistory('labs:3beira-workers:agent:inst-render', {
        limit: 1,
        offset: 0,
      });
      assert.equal(page.messages.length, 1);
      assert.equal(page.messages[0].id, call2.id);
      assert.equal(page.hasMore, true);
    } finally {
      await fakeServer.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test('LabsProvider 401 handling reports "LABS not authorised" once and does not crash synchronizer', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labs-401-'));
  const fakeServer = createFakeControlRoom({
    authError: true,
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    const baseUrl = await fakeServer.listen();
    const provider = new LabsProvider({
      baseUrl,
      storageDir: tempDir,
      pollIntervalMs: 0,
      // No token: an unconfigured LABS is an empty provider, not a failed scan.
      token: '',
      tokenPath: path.join(tempDir, 'missing.token'),
    });

    // First call -> 401 -> logs warning once
    const firstResult = await provider.sessionSynchronizer.synchronize();
    assert.equal(firstResult, 0);
    assert.equal(warnings.filter((w) => w.includes('LABS not authorised')).length, 1);

    // Second call -> 401 -> should NOT log warning again
    const secondResult = await provider.sessionSynchronizer.synchronize();
    assert.equal(secondResult, 0);
    assert.equal(warnings.filter((w) => w.includes('LABS not authorised')).length, 1);
  } finally {
    console.warn = originalWarn;
    await fakeServer.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('LabsProvider runtime and models enforce read-only contract', async () => {
  const provider = new LabsProvider();

  // Runtime
  await assert.rejects(
    provider.runtime.run('test', { sessionId: 's1' }, { send: () => {} }, {} as any),
    (err: any) => err instanceof AppError && err.statusCode === 400 && err.message.includes('read-only'),
  );
  assert.equal(provider.runtime.abort('s1'), false);

  // Models
  const catalog = await provider.models.getSupportedModels();
  assert.equal(catalog.DEFAULT, '');
  assert.deepEqual(catalog.OPTIONS, []);

  const activeModel = await provider.models.getCurrentActiveModel('s1');
  assert.equal(activeModel.model, '');

  // MCP / Skills
  await assert.rejects(
    provider.mcp.upsertServer({} as any),
    (err: any) => err instanceof AppError && err.statusCode === 400,
  );
  await assert.rejects(
    provider.skills.addSkills({} as any),
    (err: any) => err instanceof AppError && err.statusCode === 400,
  );
});
