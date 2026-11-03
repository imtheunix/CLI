import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AgySessionSynchronizer } from '@/modules/providers/list/agy/agy-session-synchronizer.provider.js';
import { AgyProvider, normalizeAgyTranscript } from '@/modules/providers/list/agy/agy.provider.js';
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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-provider-db-'));
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

const createAgyDatabase = async (homeDir: string): Promise<string> => {
  const dataDir = path.join(homeDir, '.gemini', 'antigravity-cli');
  await mkdir(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'conversation_summaries.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        preview TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT "",
        source TEXT NOT NULL DEFAULT "",
        project_id TEXT NOT NULL DEFAULT "",
        agent_name TEXT NOT NULL DEFAULT "",
        parent_conversation_id TEXT NOT NULL DEFAULT "",
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        battle_id TEXT NOT NULL DEFAULT "",
        winning_conversation_id TEXT NOT NULL DEFAULT "",
        not_fully_idle NUMERIC NOT NULL DEFAULT 0,
        killed NUMERIC NOT NULL DEFAULT 0,
        last_user_input_time DATETIME NOT NULL,
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
        app_data_dir TEXT NOT NULL DEFAULT "",
        raw_summary BLOB,
        group_id TEXT NOT NULL DEFAULT ""
      );
    `);
  } finally {
    db.close();
  }
  return dbPath;
};

test('AgySessionSynchronizer indexes native conversation summaries into sessions', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-sync-test-'));
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const restoreHome = patchHomeDir(tempRoot);

    try {
      const dbPath = await createAgyDatabase(tempRoot);
      const db = new Database(dbPath);
      try {
        const insert = db.prepare(`
          INSERT INTO conversation_summaries (
            conversation_id, title, preview, step_count, last_modified_time, last_user_input_time,
            workspace_uris, status, parent_conversation_id, killed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Normal top-level conversation
        insert.run(
          'agy-session-1',
          'First Feature Task',
          'Prompt preview 1',
          10,
          '2026-11-03 10:00:00+00:00',
          '2026-11-03 09:30:00+00:00',
          JSON.stringify([`file://${workspacePath}`]),
          'CASCADE_RUN_STATUS_IDLE',
          '',
          0
        );

        // Child subagent conversation (must be skipped)
        insert.run(
          'agy-child-subagent',
          'Subagent task',
          'Child preview',
          5,
          '2026-11-03 10:10:00+00:00',
          '2026-11-03 10:05:00+00:00',
          JSON.stringify([`file://${workspacePath}`]),
          'CASCADE_RUN_STATUS_IDLE',
          'agy-session-1',
          0
        );

        // Killed conversation (included because transcript can be shown meaningfully)
        insert.run(
          'agy-session-killed',
          'Killed conversation',
          'Killed preview',
          3,
          '2026-11-03 10:20:00+00:00',
          '2026-11-03 10:15:00+00:00',
          JSON.stringify([`file://${workspacePath}`]),
          'CASCADE_RUN_STATUS_IDLE',
          '',
          1
        );

        // Unstarted conversation with 0001 epoch
        insert.run(
          'agy-session-unstarted',
          '',
          'Fallback preview text',
          0,
          '0001-01-01 00:00:00+00:00',
          '0001-01-01 00:00:00+00:00',
          JSON.stringify([`file://${workspacePath}`]),
          'CASCADE_RUN_STATUS_IDLE',
          '',
          0
        );
      } finally {
        db.close();
      }

      const synchronizer = new AgySessionSynchronizer();
      const count = await synchronizer.synchronize();
      // Should index 3 top-level sessions (skipping the child subagent)
      assert.equal(count, 3);

      const session1 = sessionsDb.getSessionByProviderSessionId('agy-session-1');
      assert.ok(session1);
      assert.equal(session1.custom_name, 'First Feature Task');
      assert.equal(session1.provider, 'agy');
      assert.equal(session1.jsonl_path, null);

      const killedSession = sessionsDb.getSessionByProviderSessionId('agy-session-killed');
      assert.ok(killedSession);
      assert.equal(killedSession.custom_name, 'Killed conversation');

      const childSession = sessionsDb.getSessionByProviderSessionId('agy-child-subagent');
      assert.equal(childSession, null);

      const unstartedSession = sessionsDb.getSessionByProviderSessionId('agy-session-unstarted');
      assert.ok(unstartedSession);
      assert.equal(unstartedSession.custom_name, 'Fallback preview text');
      assert.ok(!unstartedSession.updated_at.startsWith('0001'));
    } finally {
      restoreHome();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test('AgySessionSynchronizer binds to pending in-app sessions before creating duplicates', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-pending-test-'));
    const workspacePath = path.join(tempRoot, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const restoreHome = patchHomeDir(tempRoot);

    try {
      // Create a pending in-app session without provider_session_id
      const appSessionId = 'app-user-created-session';
      sessionsDb.createAppSession(appSessionId, 'agy', workspacePath, 'App Assigned Title');

      const dbPath = await createAgyDatabase(tempRoot);
      const db = new Database(dbPath);
      try {
        db.prepare(`
          INSERT INTO conversation_summaries (
            conversation_id, title, preview, step_count, last_modified_time, last_user_input_time,
            workspace_uris, status, parent_conversation_id, killed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'agy-discovered-id',
          'Provider native title',
          'preview',
          1,
          '2026-11-03 12:00:00+00:00',
          '2026-11-03 12:00:00+00:00',
          JSON.stringify([`file://${workspacePath}`]),
          'CASCADE_RUN_STATUS_IDLE',
          '',
          0
        );
      } finally {
        db.close();
      }

      const synchronizer = new AgySessionSynchronizer();
      const firstId = await synchronizer.synchronizeFile(path.join(tempRoot, '.gemini', 'antigravity-cli', 'conversation_summaries.db'));
      assert.equal(firstId, appSessionId);

      const boundSession = sessionsDb.getSessionById(appSessionId);
      assert.ok(boundSession);
      assert.equal(boundSession.provider_session_id, 'agy-discovered-id');
      assert.equal(boundSession.custom_name, 'App Assigned Title');

      // Test that synchronizeFile ignores unrelated files
      assert.equal(await synchronizer.synchronizeFile('/tmp/other.db'), null);
    } finally {
      restoreHome();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test('normalizeAgyTranscript converts synthetic transcript_full.jsonl with every step type', () => {
  const syntheticLines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-03T10:00:00Z',
      content: 'Please list files and check git status',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-03T10:00:05Z',
      input_tokens: 100,
      output_tokens: 50,
      thinking: 'I need to run run_command to inspect the working directory.',
      content: 'I will inspect the workspace.',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls -la' } },
        { name: 'run_command', args: { CommandLine: 'git status' } },
      ],
    }),
    // Generic tool results paired in order
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-03T10:00:10Z',
      content: 'total 0\n-rw-r--r-- 1 busu busu 0 Nov  3 10:00 file.txt',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: 'fatal: not a git repository',
      created_at: '2026-11-03T10:00:12Z',
    }),
    JSON.stringify({
      step_index: 4,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-03T10:00:15Z',
      content: 'System notification: background worker ready',
    }),
    JSON.stringify({
      step_index: 5,
      source: 'SYSTEM',
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      error: 'Token limit exceeded, please shorten prompt',
      created_at: '2026-11-03T10:00:20Z',
    }),
    JSON.stringify({
      step_index: 6,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: '2026-11-03T10:00:25Z',
      content: '# Resuming from compaction\nSummary of earlier conversation',
    }),
    // Unpaired generic error step
    JSON.stringify({
      step_index: 7,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: 'Unpaired generic step error',
      created_at: '2026-11-03T10:00:30Z',
    }),
  ];

  const messages = normalizeAgyTranscript(syntheticLines, 'test-session', 'agy-provider-session');

  // 1. User message
  const userMsg = messages.find((m) => m.kind === 'text' && m.role === 'user');
  assert.ok(userMsg);
  assert.equal(userMsg.content, 'Please list files and check git status');

  // 2. Assistant thinking and text
  const thinkingMsg = messages.find((m) => m.kind === 'thinking');
  assert.ok(thinkingMsg);
  assert.equal(thinkingMsg.content, 'I need to run run_command to inspect the working directory.');

  const assistantTextMsg = messages.find((m) => m.kind === 'text' && m.role === 'assistant');
  assert.ok(assistantTextMsg);
  assert.equal(assistantTextMsg.content, 'I will inspect the workspace.');

  // 3. Tool use and tool results paired by order
  const toolUses = messages.filter((m) => m.kind === 'tool_use');
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].toolName, 'run_command');
  assert.deepEqual(toolUses[0].toolInput, { CommandLine: 'ls -la' });
  assert.equal(toolUses[0].toolResult?.content, 'total 0\n-rw-r--r-- 1 busu busu 0 Nov  3 10:00 file.txt');
  assert.equal(toolUses[0].toolResult?.isError, false);

  assert.equal(toolUses[1].toolName, 'run_command');
  assert.deepEqual(toolUses[1].toolInput, { CommandLine: 'git status' });
  assert.equal(toolUses[1].toolResult?.content, 'fatal: not a git repository');
  assert.equal(toolUses[1].toolResult?.isError, true);

  const toolResults = messages.filter((m) => m.kind === 'tool_result');
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0].toolId, toolUses[0].toolId);
  assert.equal(toolResults[1].toolId, toolUses[1].toolId);

  // 4. System message
  const systemMsg = messages.find((m) => m.kind === 'status' && m.text === 'system');
  assert.ok(systemMsg);
  assert.equal(systemMsg.content, 'System notification: background worker ready');

  // 5. Error message
  const errorMsg = messages.find((m) => m.kind === 'error' && m.content?.includes('Token limit exceeded'));
  assert.ok(errorMsg);

  // 6. Checkpoint message
  const checkpointMsg = messages.find((m) => m.kind === 'status' && Boolean(m.compact));
  assert.ok(checkpointMsg);
  assert.equal(checkpointMsg.isCompactSummary, true);
  assert.deepEqual(checkpointMsg.compact, { phase: 'completed' });

  // 7. Unpaired generic error
  const unpairedError = messages.find((m) => m.kind === 'error' && m.content === 'Unpaired generic step error');
  assert.ok(unpairedError);
});

test('isWatcherTargetFile identifies agy conversation_summaries.db and PROVIDER_WATCH_PATHS has agy', () => {
  assert.equal(isWatcherTargetFile('agy', '/home/busu/.gemini/antigravity-cli/conversation_summaries.db'), true);
  assert.equal(isWatcherTargetFile('agy', '/home/busu/.gemini/antigravity-cli/other.db'), false);
  assert.equal(isWatcherTargetFile('agy', '/home/busu/.gemini/antigravity-cli/transcript.jsonl'), false);

  const agyWatchPath = PROVIDER_WATCH_PATHS.find((p) => p.provider === 'agy');
  assert.ok(agyWatchPath);
  assert.ok(agyWatchPath.rootPath.endsWith(path.join('.gemini', 'antigravity-cli')));
});

test('AgyProvider fetchHistory reads native transcript_full.jsonl when app transcript is absent', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agy-fetch-history-'));
  const restoreHome = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'conv-456';
    const logDir = path.join(tempRoot, '.gemini', 'antigravity-cli', 'brain', providerSessionId, '.system_generated', 'logs');
    await mkdir(logDir, { recursive: true });

    const transcriptLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-03T10:00:00Z',
        content: 'Hello from native conversation',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-03T10:00:02Z',
        content: 'Hello back from Gemini',
      }),
    ];
    await writeFile(path.join(logDir, 'transcript_full.jsonl'), transcriptLines.join('\n'));

    const provider = new AgyProvider();
    const history = await provider.sessions.fetchHistory('app-session-1', { providerSessionId });

    assert.equal(history.total, 2);
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages[0].role, 'user');
    assert.equal(history.messages[0].content, 'Hello from native conversation');
    assert.equal(history.messages[1].role, 'assistant');
    assert.equal(history.messages[1].content, 'Hello back from Gemini');

    // Test pagination
    const page = await provider.sessions.fetchHistory('app-session-1', { providerSessionId, limit: 1, offset: 0 });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].content, 'Hello back from Gemini');
    assert.equal(page.hasMore, true);
  } finally {
    restoreHome();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
