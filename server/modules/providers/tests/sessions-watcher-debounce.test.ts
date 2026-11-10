import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import chokidar from 'chokidar';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';

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

type BroadcastFrame = { kind?: string; sessionId?: string };

type SynchronizeProviderFile = (
  provider: LLMProvider,
  filePath: string
) => Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string }>;

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

function stubWatcherDependencies(
  options: { synchronizeProviderFile?: SynchronizeProviderFile } = {}
): FakeWatcher[] {
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

  mock.method(
    sessionSynchronizerService,
    'synchronizeProviderFile',
    options.synchronizeProviderFile
      ?? (async (_provider: LLMProvider, filePath: string) => ({
        provider: 'claude' as const,
        indexed: true,
        sessionId: path.basename(filePath, path.extname(filePath)),
      }))
  );

  return fakeWatchers;
}

function findClaudeWatcher(fakeWatchers: FakeWatcher[]): FakeWatcher {
  const claudeWatcher = fakeWatchers.find((watcher) =>
    watcher.rootPath.endsWith(path.join('.claude', 'projects')),
  );
  assert.ok(claudeWatcher, 'the claude watcher was started');
  return claudeWatcher;
}

function addFakeClient(): { frames: BroadcastFrame[]; client: RealtimeClientConnection } {
  const frames: BroadcastFrame[] = [];
  const client = {
    readyState: 1,
    send: (payload: string) => {
      frames.push(JSON.parse(payload) as BroadcastFrame);
    },
  } as unknown as RealtimeClientConnection;
  connectedClients.add(client);
  return { frames, client };
}

/**
 * Makes one provider session id throw while it is resolved, the way a closed
 * better-sqlite3 connection would. The flag lets a test turn the failure off
 * to prove the retry eventually succeeds.
 */
function stubFailingSessionLookup(sessionId: string): { setFailing: (failing: boolean) => void } {
  const originalGetSessionByProviderSessionId = sessionsDb.getSessionByProviderSessionId.bind(sessionsDb);
  let failing = true;

  mock.method(sessionsDb, 'getSessionByProviderSessionId', (candidate: string) => {
    if (candidate === sessionId && failing) {
      throw new Error('database is closed');
    }
    return originalGetSessionByProviderSessionId(candidate);
  });

  return {
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('20 transcript changes within the debounce window produce one sidebar broadcast', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('native-1', 'claude', '/repo/demo', 'Demo session');

    const { frames, client } = addFakeClient();
    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      for (let eventIndex = 0; eventIndex < 20; eventIndex += 1) {
        await claudeWatcher.emit('change', '/repo/demo/native-1.jsonl');
        mock.timers.tick(25);
      }

      assert.equal(frames.length, 0, 'nothing is broadcast before the debounce elapses');

      mock.timers.tick(1_000);
      // The flush is async (it resolves the session row and builds the event),
      // so let its microtasks run before asserting.
      await flushMicrotasks();

      assert.equal(frames.length, 1, 'the 20 changes coalesce into one broadcast');
      assert.equal(frames[0]?.kind, 'session_upserted');
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('one failing session id does not suppress the good ids in the same batch', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('good-1', 'claude', '/repo/demo', 'Good one');
    sessionsDb.createSession('bad', 'claude', '/repo/demo', 'Bad one');
    sessionsDb.createSession('good-3', 'claude', '/repo/demo', 'Good three');

    const { frames, client } = addFakeClient();
    stubFailingSessionLookup('bad');
    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      await claudeWatcher.emit('change', '/repo/demo/good-1.jsonl');
      await claudeWatcher.emit('change', '/repo/demo/bad.jsonl');
      await claudeWatcher.emit('change', '/repo/demo/good-3.jsonl');

      mock.timers.tick(1_000);
      await flushMicrotasks();

      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'good-3'],
        'the bad id is isolated and the good ids still broadcast',
      );
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('a failed id is retried with backoff and broadcast once without duplicates', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('good-1', 'claude', '/repo/demo', 'Good one');
    sessionsDb.createSession('bad', 'claude', '/repo/demo', 'Bad one');
    sessionsDb.createSession('good-3', 'claude', '/repo/demo', 'Good three');

    const { frames, client } = addFakeClient();
    const failingLookup = stubFailingSessionLookup('bad');
    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      await claudeWatcher.emit('change', '/repo/demo/good-1.jsonl');
      await claudeWatcher.emit('change', '/repo/demo/bad.jsonl');
      await claudeWatcher.emit('change', '/repo/demo/good-3.jsonl');

      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.deepEqual(frames.map((frame) => frame.sessionId), ['good-1', 'good-3']);

      failingLookup.setFailing(false);
      mock.timers.tick(250);
      await flushMicrotasks();

      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'good-3', 'bad'],
        'the retry delivers the failed id exactly once',
      );

      mock.timers.tick(10_000);
      await flushMicrotasks();
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'good-3', 'bad'],
        'a successful retry leaves no timer behind',
      );
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('a failed id is not retried after the watcher closes', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('good-1', 'claude', '/repo/demo', 'Good one');
    sessionsDb.createSession('bad', 'claude', '/repo/demo', 'Bad one');

    const { frames, client } = addFakeClient();
    const failingLookup = stubFailingSessionLookup('bad');
    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      await claudeWatcher.emit('change', '/repo/demo/good-1.jsonl');
      await claudeWatcher.emit('change', '/repo/demo/bad.jsonl');

      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.deepEqual(frames.map((frame) => frame.sessionId), ['good-1']);

      await closeSessionsWatcher();
      failingLookup.setFailing(false);

      mock.timers.tick(10_000);
      await flushMicrotasks();

      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1'],
        'close cancels the pending retry',
      );
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('a sync that resolves after close does not queue, schedule or broadcast', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('native-1', 'claude', '/repo/demo', 'Demo session');

    const { frames, client } = addFakeClient();

    let markSyncStarted: () => void = () => {};
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let releaseSync: () => void = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    const fakeWatchers = stubWatcherDependencies({
      synchronizeProviderFile: async () => {
        markSyncStarted();
        await syncGate;
        return { provider: 'claude' as const, indexed: true, sessionId: 'native-1' };
      },
    });
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      claudeWatcher.emit('change', '/repo/demo/native-1.jsonl');
      await syncStarted;

      await closeSessionsWatcher();
      releaseSync();
      await flushMicrotasks();

      mock.timers.tick(5_000);
      await flushMicrotasks();

      assert.equal(frames.length, 0, 'no frame is broadcast after close');
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});
