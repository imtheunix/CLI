import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'projects-routes-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { closeConnection, initializeDatabase, projectsDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { sessionSynchronizerService } = await import('@/modules/providers/index.js');
const { default: projectsRoutes } = await import('@/modules/projects/projects.routes.js');

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'projects-routes-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
    }),
  ]);
}

function stubFailingSynchronization(): { calls: () => number; restore: () => void } {
  const original = sessionSynchronizerService.synchronizeSessions;
  let calls = 0;

  sessionSynchronizerService.synchronizeSessions = async () => {
    calls += 1;
    throw new Error('projects read routes must not run a provider scan');
  };

  return {
    calls: () => calls,
    restore: () => {
      sessionSynchronizerService.synchronizeSessions = original;
    },
  };
}

async function withProjectsServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoutes);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function getJson(baseUrl: string, pathname: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

function seedProjects(): void {
  sessionsDb.createSession('active-session', 'claude', '/tmp/active-project', 'Active session');
  sessionsDb.createSession('archived-session', 'claude', '/tmp/archived-project', 'Archived session');

  const archivedProject = projectsDb.getProjectPath('/tmp/archived-project');
  assert.ok(archivedProject, 'the archived fixture project exists');
  projectsDb.updateProjectIsArchivedById(archivedProject.project_id, true);
}

test('GET / serves cached projects without a provider scan for default and alias reads', async () => {
  await withIsolatedDatabase(async () => {
    seedProjects();
    const stub = stubFailingSynchronization();

    try {
      await withProjectsServer(async (baseUrl) => {
        const defaultRead = await withTimeout(getJson(baseUrl, '/api/projects'), 1_000);
        assert.equal(defaultRead.status, 200);
        assert.ok(Array.isArray(defaultRead.body));
        const projects = defaultRead.body as Array<{
          sessions: Array<{ lastActivity: string }>;
          [key: string]: unknown;
        }>;
        assert.equal(projects.length, 1, 'only the active project is listed');
        assert.deepEqual(projects[0], {
          projectId: projectsDb.getProjectPath('/tmp/active-project')?.project_id,
          path: '/tmp/active-project',
          displayName: 'active-project',
          fullPath: '/tmp/active-project',
          isStarred: false,
          sessions: [{
            id: 'active-session',
            provider: 'claude',
            summary: 'Active session',
            messageCount: 0,
            lastActivity: projects[0].sessions[0].lastActivity,
            spawnedBySessionId: null,
            spawnedByName: null,
          }],
          sessionMeta: { hasMore: false, total: 1 },
        });

        for (const alias of ['skipSync=1', 'skipSynchronization=1']) {
          const aliasRead = await withTimeout(getJson(baseUrl, `/api/projects?${alias}`), 1_000);
          assert.equal(aliasRead.status, 200);
          assert.deepEqual(aliasRead.body, defaultRead.body, `${alias} must not change the response`);
        }
      });

      assert.equal(stub.calls(), 0, 'no projects read may start a provider scan');
    } finally {
      stub.restore();
    }
  });
});

test('GET /archived serves cached archived projects without a provider scan for default and alias reads', async () => {
  await withIsolatedDatabase(async () => {
    seedProjects();
    const stub = stubFailingSynchronization();

    try {
      await withProjectsServer(async (baseUrl) => {
        const defaultRead = await withTimeout(getJson(baseUrl, '/api/projects/archived'), 1_000);
        assert.equal(defaultRead.status, 200);
        assert.deepEqual(Object.keys(defaultRead.body as object).sort(), ['data', 'success']);
        const body = defaultRead.body as {
          success: boolean;
          data: {
            projects: Array<{
              sessions: Array<{ lastActivity: string }>;
              [key: string]: unknown;
            }>;
          };
        };
        assert.equal(body.success, true);
        assert.equal(body.data.projects.length, 1, 'only the archived project is listed');
        assert.deepEqual(body.data.projects[0], {
          projectId: projectsDb.getProjectPath('/tmp/archived-project')?.project_id,
          path: '/tmp/archived-project',
          displayName: 'archived-project',
          fullPath: '/tmp/archived-project',
          isStarred: false,
          isArchived: true,
          sessions: [{
            id: 'archived-session',
            provider: 'claude',
            summary: 'Archived session',
            messageCount: 0,
            lastActivity: body.data.projects[0].sessions[0].lastActivity,
            spawnedBySessionId: null,
            spawnedByName: null,
          }],
          sessionMeta: { hasMore: false, total: 1 },
        });

        for (const alias of ['skipSync=1', 'skipSynchronization=1']) {
          const aliasRead = await withTimeout(
            getJson(baseUrl, `/api/projects/archived?${alias}`),
            1_000,
          );
          assert.equal(aliasRead.status, 200);
          assert.deepEqual(aliasRead.body, defaultRead.body, `${alias} must not change the response`);
        }
      });

      assert.equal(stub.calls(), 0, 'no archived read may start a provider scan');
    } finally {
      stub.restore();
    }
  });
});
