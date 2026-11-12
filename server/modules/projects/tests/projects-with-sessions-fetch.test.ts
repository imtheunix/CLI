import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'projects-fetch-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionSynchronizerService } = await import('@/modules/providers/index.js');
const { getProjectsWithSessions } = await import(
  '@/modules/projects/services/projects-with-sessions-fetch.service.js'
);

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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'projects-fetch-db-'));

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

function stubBlockedSynchronization(): {
  release: () => void;
  calls: () => number;
  restore: () => void;
} {
  const original = sessionSynchronizerService.synchronizeSessions;
  let calls = 0;
  let releaseScan: () => void = () => {};
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });

  sessionSynchronizerService.synchronizeSessions = async () => {
    calls += 1;
    await scanGate;
    return {
      processedByProvider: {
        claude: 1,
        codex: 0,
        cursor: 0,
        opencode: 0,
        agy: 0,
        labs: 0,
        zcode: 0,
      },
      prunedOrphans: 0,
      failures: [],
    };
  };

  return {
    release: () => releaseScan(),
    calls: () => calls,
    restore: () => {
      sessionSynchronizerService.synchronizeSessions = original;
    },
  };
}

test('the projects read serves cached sessions before a blocked scan resolves', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('cached-session', 'claude', '/tmp/cached-project', 'Cached session');

    const frames: Array<{ kind?: string }> = [];
    const client = {
      readyState: 1,
      send: (payload: string) => {
        frames.push(JSON.parse(payload) as { kind?: string });
      },
    } as unknown as RealtimeClientConnection;
    connectedClients.add(client);

    const stub = stubBlockedSynchronization();

    try {
      const projects = await withTimeout(getProjectsWithSessions(), 1_000);

      assert.equal(stub.calls(), 1, 'the read starts a background scan');
      const cachedProject = projects.find((project) => project.path === '/tmp/cached-project');
      assert.ok(cachedProject, 'the cached project is returned immediately');
      assert.deepEqual(
        cachedProject.sessions.map((session) => session.id),
        ['cached-session'],
        'the cached session is returned before the scan resolves',
      );

      stub.release();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.ok(
        frames.some((frame) => frame.kind === 'projects_refresh'),
        'clients are told to re-read once the background scan indexed something',
      );
    } finally {
      stub.restore();
      connectedClients.delete(client);
    }
  });
});

test('skipSynchronization reads the DB without starting a scan', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('cached-session', 'claude', '/tmp/cached-project', 'Cached session');

    const stub = stubBlockedSynchronization();

    try {
      const projects = await withTimeout(
        getProjectsWithSessions({ skipSynchronization: true }),
        1_000,
      );

      assert.equal(stub.calls(), 0, 'the skip path never starts a scan');
      assert.ok(projects.some((project) => project.path === '/tmp/cached-project'));
    } finally {
      stub.restore();
    }
  });
});
