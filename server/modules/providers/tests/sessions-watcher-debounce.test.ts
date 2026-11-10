import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import chokidar from 'chokidar';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * The sessions watcher is the trigger path from a transcript change to the
 * sidebar broadcast: `onUpdate` -> `queuePendingWatcherUpdate` ->
 * `schedulePendingWatcherFlush` -> `flushPendingWatcherUpdate` ->
 * `broadcastSessionUpsertedBatch`. A streaming OpenCode job rewrites its
 * database every few seconds, so without coalescing each rewrite would fan out
 * into its own broadcast (and, on older clients, its own full project rebuild).
 */

const fixtureHome = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { initializeSessionsWatcher, closeSessionsWatcher } = await import(
  '@/modules/providers/services/sessions-watcher.service.js'
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

type FakeWatcher = {
  rootPath: string;
  handlers: Map<string, (filePath: string) => unknown>;
  emit: (event: string, filePath: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-db-'));

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

function stubWatcherDependencies(): FakeWatcher[] {
  const fakeWatchers: FakeWatcher[] = [];

  mock.method(chokidar, 'watch', (rootPath: string) => {
    const handlers = new Map<string, (filePath: string) => unknown>();
    const fakeWatcher: FakeWatcher = {
      rootPath,
      handlers,
      emit: async (event, filePath) => handlers.get(event)?.(filePath),
      close: async () => {},
    };
    fakeWatchers.push(fakeWatcher);
    return {
      on(event: string, handler: (filePath: string) => unknown) {
        handlers.set(event, handler);
        return this;
      },
      close: fakeWatcher.close,
    };
  });

  mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => ({
    processedByProvider: {
      claude: 0,
      cursor: 0,
      codex: 0,
      opencode: 0,
      agy: 0,
      labs: 0,
      zcode: 0,
    },
    prunedOrphans: 0,
    failures: [],
  }));

  mock.method(sessionSynchronizerService, 'synchronizeProviderFile', async () => ({
    provider: 'claude' as const,
    indexed: true,
    sessionId: 'native-1',
  }));

  return fakeWatchers;
}

test('20 transcript changes in 500 ms produce one sidebar broadcast', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('native-1', 'claude', '/repo/demo', 'Demo session');

    const frames: Array<{ kind?: string }> = [];
    const fakeClient = {
      readyState: 1,
      send: (payload: string) => {
        frames.push(JSON.parse(payload) as { kind?: string });
      },
    } as unknown as RealtimeClientConnection;
    connectedClients.add(fakeClient);

    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = fakeWatchers.find((watcher) =>
        watcher.rootPath.endsWith(path.join('.claude', 'projects')),
      );
      assert.ok(claudeWatcher, 'the claude watcher was started');

      for (let eventIndex = 0; eventIndex < 20; eventIndex += 1) {
        await claudeWatcher.emit('change', '/repo/demo/native-1.jsonl');
        mock.timers.tick(25);
      }

      assert.equal(frames.length, 0, 'nothing is broadcast before the debounce elapses');

      mock.timers.tick(1_000);
      // The flush is async (it resolves the session row and builds the event),
      // so let its microtasks run before asserting.
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(frames.length, 1, 'the 20 changes coalesce into one broadcast');
      assert.equal(frames[0]?.kind, 'session_upserted');
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(fakeClient);
      mock.restoreAll();
    }
  });
});
