import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-details-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('getSessionDetailsById resolves the owning project for a disk-indexed session', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/home/user/example-project';
    const sessionId = sessionsDb.createSession('provider-abc', 'claude', projectPath, 'My session');
    const projectRow = projectsDb.getProjectPath(projectPath);
    assert.ok(projectRow, 'project row should exist after createSession');

    const details = await sessionsService.getSessionDetailsById(sessionId);

    assert.equal(details.sessionId, sessionId);
    assert.equal(details.provider, 'claude');
    assert.equal(details.summary, 'My session');
    assert.equal(details.isArchived, false);
    assert.equal(details.spawnedBySessionId, null);
    assert.deepEqual(details.spawnedSessions, []);
    assert.ok(details.project, 'project should be resolved');
    assert.equal(details.project?.projectId, projectRow?.project_id);
    // Paths are normalized to platform separators when stored.
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('getSessionDetailsById falls back to the provider-native id and returns the canonical app id', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/home/user/alias-project';
    const appSessionId = sessionsDb.createAppSession('app-session-1', 'claude', projectPath);
    sessionsDb.assignProviderSessionId(appSessionId, 'provider-native-1');

    const details = await sessionsService.getSessionDetailsById('provider-native-1');

    assert.equal(details.sessionId, appSessionId);
    assert.equal(details.project?.fullPath, normalizeProjectPath(projectPath));
  });
});

test('getSessionDetailsById lists the sessions this one spawned, newest first, with a running flag', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/home/user/spawn-project';
    const parent = sessionsDb.createSession('parent-provider', 'claude', projectPath, 'Parent');
    sessionsDb.createSession('spawn-older', 'codex', projectPath, 'Older spawn', '2026-10-20T10:00:00Z', '2026-10-20T10:05:00Z');
    sessionsDb.createSession('spawn-newer', 'codex', projectPath, 'Newer spawn', '2026-10-24T10:00:00Z', '2026-10-24T10:05:00Z');
    sessionsDb.setSessionSpawnedBy('spawn-older', parent);
    sessionsDb.setSessionSpawnedBy('spawn-newer', parent);

    const details = await sessionsService.getSessionDetailsById(parent);

    assert.equal(details.spawnedBySessionId, null, 'the parent itself was not spawned');
    assert.deepEqual(
      details.spawnedSessions.map((child) => [child.sessionId, child.name, child.provider, child.running]),
      [
        ['spawn-newer', 'Newer spawn', 'codex', false],
        ['spawn-older', 'Older spawn', 'codex', false],
      ],
    );
  });
});

test('getSessionDetailsById throws SESSION_NOT_FOUND for unknown ids', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      () => sessionsService.getSessionDetailsById('does-not-exist'),
      (error: unknown) => error instanceof AppError && error.code === 'SESSION_NOT_FOUND',
    );
  });
});
