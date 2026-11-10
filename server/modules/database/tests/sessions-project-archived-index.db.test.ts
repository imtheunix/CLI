import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * The sidebar reads one project's sessions at a time. Both the page query and
 * the count query filter on `project_path` and `isArchived`; without the
 * composite index SQLite picks `idx_sessions_is_archived` and scans every
 * session row for every project (68k rows x 562 projects on a real install).
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-project-index-'));
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

const PAGE_QUERY = `
  SELECT session_id, provider, custom_name, project_path, jsonl_path, model, effort,
         agent, forked_from_session_id, spawned_by_session_id, isArchived,
         created_at, updated_at
  FROM sessions
  WHERE project_path = ?
    AND isArchived = 0
  ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
  LIMIT 20 OFFSET 0
`;

const COUNT_QUERY = `
  SELECT COUNT(*) AS count
  FROM sessions
  WHERE project_path = ?
    AND isArchived = 0
`;

function seedSessions(): void {
  const db = getConnection();
  const insertProject = db.prepare(
    'INSERT OR IGNORE INTO projects (project_id, project_path) VALUES (?, ?)',
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, provider, project_path, isArchived, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );

  const seed = db.transaction(() => {
    for (let projectIndex = 0; projectIndex < 20; projectIndex += 1) {
      insertProject.run(`project-${projectIndex}`, `/repo/project-${projectIndex}`);
    }
    for (let sessionIndex = 0; sessionIndex < 1_000; sessionIndex += 1) {
      insertSession.run(
        `session-${sessionIndex}`,
        'claude',
        `/repo/project-${sessionIndex % 20}`,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    }
  });

  seed();
  db.exec('ANALYZE');
}

function queryPlan(sql: string): string {
  return (getConnection().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('/repo/project-1') as Array<{
    detail: string;
  }>)
    .map((row) => row.detail)
    .join('\n');
}

test('the composite project/archive index exists after migrations and is idempotent', async () => {
  await withIsolatedDatabase(async () => {
    const indexNames = (getConnection()
      .prepare('PRAGMA index_list(sessions)')
      .all() as Array<{ name: string }>)
      .map((index) => index.name);
    assert.ok(
      indexNames.includes('idx_sessions_project_archived'),
      'the sidebar lookup has a composite index',
    );

    // A second startup must not fail on the already-created index.
    await initializeDatabase();
    const indexNamesAfterRestart = (getConnection()
      .prepare('PRAGMA index_list(sessions)')
      .all() as Array<{ name: string }>)
      .map((index) => index.name);
    assert.ok(indexNamesAfterRestart.includes('idx_sessions_project_archived'));
  });
});

test('the project session page query uses the composite index', async () => {
  await withIsolatedDatabase(() => {
    seedSessions();
    const plan = queryPlan(PAGE_QUERY);
    assert.match(plan, /idx_sessions_project_archived/);
  });
});

test('the project session count query uses the composite covering index', async () => {
  await withIsolatedDatabase(() => {
    seedSessions();
    const plan = queryPlan(COUNT_QUERY);
    assert.match(plan, /COVERING INDEX idx_sessions_project_archived/);
  });
});
