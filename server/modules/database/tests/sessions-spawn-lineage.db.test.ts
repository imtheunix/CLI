import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

/**
 * The `spawned_by_session_id` column records which session spawned another
 * from its shell. Its invariants: written once at discovery, never
 * overwritten, and readable as a session's spawned children.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-spawn-'));
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

test('a fresh database carries the spawned_by_session_id column and its index', async () => {
  await withIsolatedDatabase(() => {
    const columns = (getConnection()
      .prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(columns.includes('spawned_by_session_id'), 'the column exists after migrations');

    const indexes = (getConnection()
      .prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>)
      .map((index) => index.name);
    assert.ok(indexes.includes('idx_sessions_spawned_by'), 'the lineage lookup has an index');
  });
});

test('setSessionSpawnedBy writes once and never overwrites a recorded parent', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('child-provider-1', 'codex', '/repo/demo', 'Child');
    sessionsDb.createSession('parent-provider-1', 'claude', '/repo/demo', 'Parent');

    sessionsDb.setSessionSpawnedBy('child-provider-1', 'parent-provider-1');
    assert.equal(sessionsDb.getSessionById('child-provider-1')?.spawned_by_session_id, 'parent-provider-1');

    // A second discovery (or a stale scan) must not move lineage.
    sessionsDb.setSessionSpawnedBy('child-provider-1', 'another-parent');
    assert.equal(sessionsDb.getSessionById('child-provider-1')?.spawned_by_session_id, 'parent-provider-1');
  });
});

test('getSessionsSpawnedBy lists a session\'s children, newest first, without archived ones', async () => {
  await withIsolatedDatabase(() => {
    const parent = sessionsDb.createSession('parent-provider-1', 'claude', '/repo/demo', 'Parent');
    sessionsDb.createSession('child-older', 'codex', '/repo/demo', 'Older child', '2026-10-20T10:00:00Z', '2026-10-20T10:05:00Z');
    sessionsDb.createSession('child-newer', 'codex', '/repo/demo', 'Newer child', '2026-10-24T10:00:00Z', '2026-10-24T10:05:00Z');
    sessionsDb.createSession('child-archived', 'opencode', '/repo/demo', 'Archived child', '2026-10-22T10:00:00Z', '2026-10-22T10:05:00Z');
    sessionsDb.setSessionSpawnedBy('child-older', parent);
    sessionsDb.setSessionSpawnedBy('child-newer', parent);
    sessionsDb.setSessionSpawnedBy('child-archived', parent);
    sessionsDb.updateSessionIsArchived('child-archived', true);

    const children = sessionsDb.getSessionsSpawnedBy(parent);

    assert.deepEqual(children.map((child) => child.session_id), ['child-newer', 'child-older']);
    assert.equal(sessionsDb.getSessionsSpawnedBy('child-newer').length, 0, 'a childless session lists nothing');
  });
});


test('upgrading a pre-lineage database twice preserves sessions and recorded parents', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('existing', 'claude', '/repo/demo', 'Keep this name');
    const db = getConnection();
    db.exec('DROP INDEX idx_sessions_spawned_by');
    db.exec('ALTER TABLE sessions DROP COLUMN spawned_by_session_id');
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('existing')?.custom_name, 'Keep this name');
    assert.equal(sessionsDb.getSessionById('existing')?.spawned_by_session_id, null);
    sessionsDb.setSessionSpawnedBy('existing', 'parent');
    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('existing')?.spawned_by_session_id, 'parent');
    assert.ok((db.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>).some((row) => row.name === 'idx_sessions_spawned_by'));
  });
});
