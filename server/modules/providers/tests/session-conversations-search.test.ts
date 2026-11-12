import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';
import { getZcodeTranscriptPath } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withSearchEnvironment(
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'session-search-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const restoreHomeDir = patchHomeDir(tempRoot);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    await run(tempRoot);
  } finally {
    closeConnection();
    restoreHomeDir();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

type OpenCodeSeedMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timeCreated: number;
};

async function seedOpenCodeDatabase(
  homeDir: string,
  sessions: Array<{ sessionId: string; messages: OpenCodeSeedMessage[] }>,
): Promise<void> {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id);
    `);

    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    );
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    );

    db.transaction(() => {
      for (const session of sessions) {
        for (const message of session.messages) {
          insertMessage.run(
            message.id,
            session.sessionId,
            message.timeCreated,
            JSON.stringify({ role: message.role }),
          );
          insertPart.run(
            `${message.id}-part`,
            message.id,
            session.sessionId,
            message.timeCreated,
            JSON.stringify({ type: 'text', text: message.text }),
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}

test('title search finds a job session by its job id and session id prefix', async () => {
  await withSearchEnvironment(async (tempRoot) => {
    const jobPath = path.join(tempRoot, 'Tribeira', '.jobs', 'tribeiracli', '8086ffb8');
    sessionsDb.createAppSession('job-session', 'claude', jobPath, 'GLM Flash · old title');

    const byJobId = await searchConversations('8086ffb8', 50);
    assert.equal(byJobId.titleResults.length, 1);
    assert.equal(byJobId.titleResults[0]?.sessionId, 'job-session');
    assert.equal(byJobId.titleResults[0]?.sessionTitle, 'GLM Flash · old title');

    const bySessionPrefix = await searchConversations('job-ses', 50);
    assert.equal(bySessionPrefix.titleResults.length, 1);
    assert.equal(bySessionPrefix.titleResults[0]?.sessionId, 'job-session');
  });
});

test('conversation search finds OpenCode text parts from the shared database', async () => {
  await withSearchEnvironment(async (tempRoot) => {
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    sessionsDb.createAppSession('oc-app', 'opencode', workspacePath, 'OpenCode job');
    sessionsDb.assignProviderSessionId('oc-app', 'oc-1');

    await seedOpenCodeDatabase(tempRoot, [{
      sessionId: 'oc-1',
      messages: [
        { id: 'oc-message-1', role: 'user', text: 'The checkout crash happens on submit', timeCreated: 1_700_000_000_000 },
      ],
    }]);

    const result = await searchConversations('checkout crash', 50);
    assert.equal(result.totalMatches, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.sessions[0]?.sessionId, 'oc-app');
    assert.equal(result.results[0]?.sessions[0]?.provider, 'opencode');
    assert.match(result.results[0]?.sessions[0]?.matches[0]?.snippet ?? '', /checkout crash/);
  });
});

test('conversation search joins ZCode text deltas per message', async () => {
  await withSearchEnvironment(async (tempRoot) => {
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    sessionsDb.createAppSession('zc-app', 'zcode', workspacePath, 'ZCode job');
    sessionsDb.assignProviderSessionId('zc-app', 'zc-1');

    const transcriptPath = getZcodeTranscriptPath('zc-app');
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, [
      JSON.stringify({ event: 'user', content: 'Please fix the login flow', timestamp: '2026-11-10T10:00:00.000Z' }),
      JSON.stringify({ event: 'stream_delta', content: 'The login ', timestamp: '2026-11-10T10:00:01.000Z' }),
      JSON.stringify({ event: 'stream_delta', content: 'flow is fixed', timestamp: '2026-11-10T10:00:02.000Z' }),
    ].join('\n') + '\n');

    const result = await searchConversations('login flow is fixed', 50);
    assert.equal(result.totalMatches, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.sessions[0]?.sessionId, 'zc-app');
    assert.equal(result.results[0]?.sessions[0]?.provider, 'zcode');
    assert.match(result.results[0]?.sessions[0]?.matches[0]?.snippet ?? '', /login flow is fixed/);
  });
});

test('a large OpenCode fixture stays within the search time budget', async () => {
  await withSearchEnvironment(async (tempRoot) => {
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });

    const messages: OpenCodeSeedMessage[] = [];
    for (let sessionIndex = 0; sessionIndex < 100; sessionIndex += 1) {
      const sessionId = `oc-bulk-${sessionIndex}`;
      sessionsDb.createAppSession(`app-bulk-${sessionIndex}`, 'opencode', workspacePath, `Bulk ${sessionIndex}`);
      sessionsDb.assignProviderSessionId(`app-bulk-${sessionIndex}`, sessionId);

      for (let messageIndex = 0; messageIndex < 30; messageIndex += 1) {
        messages.push({
          id: `${sessionId}-message-${messageIndex}`,
          role: messageIndex % 2 === 0 ? 'user' : 'assistant',
          text: `ordinary filler text number ${messageIndex} for session ${sessionIndex}`,
          timeCreated: 1_700_000_000_000 + sessionIndex * 1_000 + messageIndex,
        });
      }
    }
    messages.push({
      id: 'oc-bulk-needle',
      role: 'user',
      text: 'the unique needle phrase lives here',
      timeCreated: 1_700_000_100_000,
    });
    sessionsDb.createAppSession('app-bulk-needle', 'opencode', workspacePath, 'Bulk needle');
    sessionsDb.assignProviderSessionId('app-bulk-needle', 'oc-bulk-needle');

    const bulkSessions = Array.from({ length: 100 }, (_, sessionIndex) => {
      const sessionId = `oc-bulk-${sessionIndex}`;
      return {
        sessionId,
        messages: messages.filter((message) => message.id.startsWith(`${sessionId}-`)),
      };
    });
    bulkSessions.push({
      sessionId: 'oc-bulk-needle',
      messages: messages.filter((message) => message.id === 'oc-bulk-needle'),
    });
    await seedOpenCodeDatabase(tempRoot, bulkSessions);

    const startedAt = Date.now();
    const result = await searchConversations('unique needle phrase', 50);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.totalMatches, 1);
    assert.equal(result.results[0]?.sessions[0]?.sessionId, 'app-bulk-needle');
    assert.ok(elapsedMs < 3_000, `search took ${elapsedMs}ms`);
  });
});
