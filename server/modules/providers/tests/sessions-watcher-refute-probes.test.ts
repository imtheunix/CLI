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
 * Refute-job adversarial probes for commit 736cb144 (watcher retry + close
 * race). These complement sessions-watcher-debounce.test.ts by attacking the
 * fix itself: backoff escalation and the attempt cap under repeated failures,
 * close during an in-flight retry broadcast (plus re-init reset), and the
 * retry/fresh-event dedupe path that must not double-broadcast an id.
 */

const fixtureHome = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-probe-home-'));
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

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-probe-db-'));

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

  mock.method(sessionSynchronizerService, 'synchronizeProviderFile', async (_provider: LLMProvider, filePath: string) => ({
    provider: 'claude' as const,
    indexed: true,
    sessionId: path.basename(filePath, path.extname(filePath)),
  }));

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

type FailingLookup = { setFailing: (failing: boolean) => void; badCalls: () => number };

/**
 * Makes the lookup for one provider session id throw, the way a closed
 * better-sqlite3 connection would, and counts how often that id is asked for.
 */
function stubFailingSessionLookup(sessionId: string): FailingLookup {
  const originalGetSessionByProviderSessionId =
    sessionsDb.getSessionByProviderSessionId.bind(sessionsDb);
  let failing = true;
  let badCalls = 0;

  mock.method(sessionsDb, 'getSessionByProviderSessionId', (candidate: string) => {
    if (candidate === sessionId) {
      badCalls += 1;
      if (failing) {
        throw new Error('database is closed');
      }
    }
    return originalGetSessionByProviderSessionId(candidate);
  });

  return {
    setFailing: (value: boolean) => {
      failing = value;
    },
    badCalls: () => badCalls,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('repeated failures escalate backoff 250/500/1000/2000/2000 and the cap drops the id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('good-1', 'claude', '/repo/demo', 'Good one');
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
      assert.equal(failingLookup.badCalls(), 1, 'the initial flush asked for bad once');

      // Five retry attempts: 250, 500, 1000, 2000, 2000 (cumulative 250/750/1750/3750/5750).
      mock.timers.tick(250);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 2, 'first retry');
      mock.timers.tick(500);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 3, 'second retry');
      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 4, 'third retry');
      mock.timers.tick(2_000);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 5, 'fourth retry');
      mock.timers.tick(2_000);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 6, 'fifth retry, then the cap drops the id');

      mock.timers.tick(30_000);
      await flushMicrotasks();
      assert.equal(failingLookup.badCalls(), 6, 'no timer survives the attempt cap');
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'good-3'],
        'good ids broadcast exactly once across the whole failure chain',
      );
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('close during an in-flight retry broadcast leaves one bounded frame and re-init resets the guard', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('good-1', 'claude', '/repo/demo', 'Good one');
    sessionsDb.createSession('bad', 'claude', '/repo/demo', 'Bad one');
    sessionsDb.createSession('good-2', 'claude', '/repo/demo', 'Good two');

    const { frames, client } = addFakeClient();

    // The first lookup for 'bad' throws (arms the retry). The retry's lookup
    // kicks off closeSessionsWatcher from inside the broadcast, so the close
    // lifecycle prelude lands while the retry flush is mid-broadcast.
    const originalGetSessionByProviderSessionId =
      sessionsDb.getSessionByProviderSessionId.bind(sessionsDb);
    let badCalls = 0;
    let closePromise: Promise<void> | null = null;
    mock.method(sessionsDb, 'getSessionByProviderSessionId', (candidate: string) => {
      if (candidate === 'bad') {
        badCalls += 1;
        if (badCalls === 1) {
          throw new Error('database is closed');
        }
        if (!closePromise) {
          closePromise = closeSessionsWatcher();
        }
      }
      return originalGetSessionByProviderSessionId(candidate);
    });

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

      mock.timers.tick(250);
      await flushMicrotasks();
      assert.ok(closePromise, 'close was triggered from inside the in-flight retry broadcast');
      await closePromise;

      // The one broadcast that was already in flight when close landed still
      // delivers its frame; nothing else may be scheduled afterwards.
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'bad'],
        'only the in-flight frame lands across the close',
      );

      mock.timers.tick(30_000);
      await flushMicrotasks();
      assert.deepEqual(frames.map((frame) => frame.sessionId), ['good-1', 'bad'], 'close cancels the retry chain');

      // Re-initializing must reset the closed/generation guard.
      await initializeSessionsWatcher();
      const revivedWatcher = findClaudeWatcher(fakeWatchers);
      await revivedWatcher.emit('change', '/repo/demo/good-2.jsonl');
      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'bad', 'good-2'],
        'a fresh event broadcasts after re-initialization',
      );

      mock.timers.tick(30_000);
      await flushMicrotasks();
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['good-1', 'bad', 'good-2'],
        'the stale retry ids from before close are not resurrected',
      );
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});

test('a fresh event for a failed id supersedes the retry and broadcasts exactly once', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('x', 'claude', '/repo/demo', 'X session');

    const { frames, client } = addFakeClient();
    const failingLookup = stubFailingSessionLookup('x');
    const fakeWatchers = stubWatcherDependencies();
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    try {
      await initializeSessionsWatcher();
      const claudeWatcher = findClaudeWatcher(fakeWatchers);

      await claudeWatcher.emit('change', '/repo/demo/x.jsonl');
      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.deepEqual(frames.map((frame) => frame.sessionId), [], 'x failed and waits on retry');

      failingLookup.setFailing(false);
      await claudeWatcher.emit('change', '/repo/demo/x.jsonl');

      mock.timers.tick(250);
      await flushMicrotasks();
      mock.timers.tick(1_000);
      await flushMicrotasks();
      assert.deepEqual(
        frames.map((frame) => frame.sessionId),
        ['x'],
        'the fresh event supersedes the retry: one frame, no duplicate',
      );

      mock.timers.tick(30_000);
      await flushMicrotasks();
      assert.deepEqual(frames.map((frame) => frame.sessionId), ['x'], 'no retry timer survives the supersede');
    } finally {
      mock.timers.reset();
      await closeSessionsWatcher();
      connectedClients.delete(client);
      mock.restoreAll();
    }
  });
});
