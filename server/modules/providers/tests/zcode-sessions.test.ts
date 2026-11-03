import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ZcodeSessionSynchronizer } from '@/modules/providers/list/zcode/zcode-session-synchronizer.provider.js';
import { ZcodeProvider } from '@/modules/providers/list/zcode/zcode.provider.js';
import { isWatcherTargetFile, PROVIDER_WATCH_PATHS } from '@/modules/providers/services/sessions-watcher.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-db-'));
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

const createZcodeDatabase = async (homeDir: string): Promise<string> => {
  const dbDir = path.join(homeDir, '.zcode', 'cli', 'db');
  await mkdir(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'db.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        directory TEXT,
        path TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        parent_id TEXT,
        time_deleted INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT,
        time_created INTEGER,
        sequence INTEGER
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        message_id TEXT,
        data TEXT,
        time_created INTEGER,
        sequence INTEGER
      );
    `);
  } finally {
    db.close();
  }
  return dbPath;
};

test('ZcodeSessionSynchronizer indexes native sessions into sessions table and ignores children', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'zcode-sync-test-'));
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const restoreHome = patchHomeDir(tempRoot);

    try {
      const dbPath = await createZcodeDatabase(tempRoot);
      const db = new Database(dbPath);
      try {
        const insertSession = db.prepare(`
          INSERT INTO session (id, title, directory, path, time_created, time_updated, parent_id, time_deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Root top-level session
        insertSession.run('sess_top_1', 'Main Task', workspacePath, workspacePath, 1710000000000, 1710000005000, null, null);
        // Child session (should not be indexed / pruned)
        insertSession.run('sess_child_1', 'Subagent Step', workspacePath, workspacePath, 1710000001000, 1710000002000, 'sess_top_1', null);
        // Deleted session (should be ignored)
        insertSession.run('sess_deleted_1', 'Deleted Task', workspacePath, workspacePath, 1710000000000, 1710000001000, null, 1710000002000);
      } finally {
        db.close();
      }

      const synchronizer = new ZcodeSessionSynchronizer();
      const count = await synchronizer.synchronize();
      assert.equal(count, 1);

      const session1 = sessionsDb.getSessionByProviderSessionId('sess_top_1');
      assert.ok(session1);
      assert.equal(session1.session_id, 'sess_top_1');
      assert.equal(session1.custom_name, 'Main Task');

      const childSession = sessionsDb.getSessionByProviderSessionId('sess_child_1');
      assert.equal(childSession, null);

      const deletedSession = sessionsDb.getSessionByProviderSessionId('sess_deleted_1');
      assert.equal(deletedSession, null);

      // synchronizeFile test on db.sqlite
      const firstId = await synchronizer.synchronizeFile(path.join(tempRoot, '.zcode', 'cli', 'db', 'db.sqlite'));
      assert.equal(firstId, 'sess_top_1');
    } finally {
      restoreHome();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test('sessions-watcher recognizes zcode watch paths', () => {
  const zcodeWatchRoot = PROVIDER_WATCH_PATHS.find((p) => p.provider === 'zcode');
  assert.ok(zcodeWatchRoot);

  const home = os.homedir();
  assert.equal(isWatcherTargetFile('zcode', path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')), true);
  assert.equal(isWatcherTargetFile('zcode', path.join(home, '.cloudcli', 'zcode', 'sess-1.jsonl')), true);
  assert.equal(isWatcherTargetFile('zcode', path.join(home, '.zcode', 'other.txt')), false);
});

test('ZcodeProvider.sessions.fetchHistory falls back to native sqlite history when jsonl is absent', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'zcode-history-test-'));
  const restoreHome = patchHomeDir(tempRoot);

  try {
    const dbPath = await createZcodeDatabase(tempRoot);
    const db = new Database(dbPath);
    try {
      db.prepare(`
        INSERT INTO session (id, title, directory, path, time_created, time_updated, parent_id, time_deleted)
        VALUES ('sess_123', 'History Test', '/tmp/project', '/tmp/project', 1710000000000, 1710000005000, null, null)
      `).run();

      db.prepare(`
        INSERT INTO message (id, session_id, data, time_created, sequence)
        VALUES ('msg_1', 'sess_123', ?, 1710000001000, 1)
      `).run(JSON.stringify({ role: 'user' }));

      db.prepare(`
        INSERT INTO part (id, session_id, message_id, data, time_created, sequence)
        VALUES ('part_1', 'sess_123', 'msg_1', ?, 1710000001100, 1)
      `).run(JSON.stringify({ type: 'text', text: 'Where is the config?' }));

      db.prepare(`
        INSERT INTO message (id, session_id, data, time_created, sequence)
        VALUES ('msg_2', 'sess_123', ?, 1710000002000, 2)
      `).run(JSON.stringify({ role: 'assistant' }));

      db.prepare(`
        INSERT INTO part (id, session_id, message_id, data, time_created, sequence)
        VALUES ('part_2', 'sess_123', 'msg_2', ?, 1710000002100, 1)
      `).run(JSON.stringify({ type: 'tool', id: 'tool_call_1', name: 'search_web', input: { query: 'test' } }));

      db.prepare(`
        INSERT INTO part (id, session_id, message_id, data, time_created, sequence)
        VALUES ('part_3', 'sess_123', 'msg_2', ?, 1710000002200, 2)
      `).run(JSON.stringify({ type: 'text', text: 'Here is the answer.' }));
    } finally {
      db.close();
    }

    const provider = new ZcodeProvider();
    const history = await provider.sessions.fetchHistory('sess_123');
    assert.equal(history.messages.length, 3);
    assert.equal(history.messages[0].role, 'user');
    assert.equal(history.messages[0].content, 'Where is the config?');
    assert.equal(history.messages[1].kind, 'tool_use');
    assert.equal(history.messages[1].toolName, 'search_web');
    assert.equal(history.messages[2].role, 'assistant');
    assert.equal(history.messages[2].content, 'Here is the answer.');
    assert.equal(history.messages[2].model, 'GLM-5.3-Flash');
  } finally {
    restoreHome();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
