import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
  type SessionsWatcherPath,
} from '@/modules/providers/services/sessions-watcher.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';

/**
 * These tests use real temporary directories and the real chokidar watcher.
 * Only the provider synchronizer and the websocket client set are stubbed, so
 * the path under test is the actual filesystem event -> onUpdate -> coalescer
 * -> broadcast chain. No production session directory or external model is
 * touched.
 */

type BroadcastFrame = { kind?: string; sessionId?: string };

type SynchronizeProviderFile = (
  provider: LLMProvider,
  filePath: string
) => Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string }>;

const EMPTY_SYNC_RESULT = {
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
  failures: [] as string[],
};

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-native-db-'));

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

async function withTempRoot(runTest: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'sessions-watcher-native-'));
  try {
    await runTest(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stubSynchronizer(options: {
  synchronizeProviderFile?: SynchronizeProviderFile;
  onSynchronizeSessions?: () => Promise<void> | void;
} = {}): { providerFileCalls: string[]; sessionScanCalls: number } {
  const providerFileCalls: string[] = [];
  const state = { providerFileCalls, sessionScanCalls: 0 };

  mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => {
    state.sessionScanCalls += 1;
    await options.onSynchronizeSessions?.();
    return EMPTY_SYNC_RESULT;
  });

  mock.method(
    sessionSynchronizerService,
    'synchronizeProviderFile',
    options.synchronizeProviderFile
      ?? (async (provider: LLMProvider, filePath: string) => {
        providerFileCalls.push(filePath);
        return {
          provider,
          indexed: true,
          sessionId: path.basename(filePath, path.extname(filePath)),
        };
      })
  );

  return state;
}

function addFakeClient(): {
  frames: BroadcastFrame[];
  client: RealtimeClientConnection;
  waitForFrame: (timeoutMs?: number) => Promise<BroadcastFrame>;
} {
  const frames: BroadcastFrame[] = [];
  const waiters: Array<(frame: BroadcastFrame) => void> = [];
  let consumedFrames = 0;

  const client = {
    readyState: 1,
    send: (payload: string) => {
      const frame = JSON.parse(payload) as BroadcastFrame;
      frames.push(frame);
      for (const waiter of waiters.splice(0)) {
        waiter(frame);
      }
    },
  } as unknown as RealtimeClientConnection;

  connectedClients.add(client);

  return {
    frames,
    client,
    waitForFrame: (timeoutMs = 5_000) => {
      if (frames.length > consumedFrames) {
        return Promise.resolve(frames[consumedFrames++]!);
      }

      return new Promise<BroadcastFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms waiting for a broadcast frame`));
        }, timeoutMs);

        waiters.push((frame) => {
          clearTimeout(timer);
          consumedFrames += 1;
          resolve(frame);
        });
      });
    },
  };
}

function waitForInitialScan(state: { sessionScanCalls: number }, expected = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (state.sessionScanCalls >= expected) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 5_000) {
        reject(new Error('timed out waiting for the initial session scan'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a real file change reaches the change handler well before the old six-second poll', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      await mkdir(watchRoot, { recursive: true });
      sessionsDb.createSession('native-1', 'claude', '/repo/demo', 'Native one');

      const state = stubSynchronizer();
      const { frames, client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        const startedAt = performance.now();
        await writeFile(path.join(watchRoot, 'native-1.jsonl'), '{"type":"user"}\n');
        const frame = await waitForFrame(5_000);
        const elapsedMs = performance.now() - startedAt;

        assert.equal(frame.kind, 'session_upserted');
        assert.equal(frame.sessionId, 'native-1');
        console.log(`native watcher update latency: ${elapsedMs.toFixed(0)}ms`);
        assert.ok(
          elapsedMs < 5_000,
          `native event should arrive before the former 6000ms poll tick, took ${elapsedMs.toFixed(0)}ms`
        );
        assert.equal(state.sessionScanCalls, 1, 'a file change must not trigger a full provider rescan');
        assert.deepEqual(state.providerFileCalls, [path.join(watchRoot, 'native-1.jsonl')]);
        assert.equal(frames.length, 1);
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('existing files are covered by the initial scan and a file created during registration is not missed', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      await mkdir(watchRoot, { recursive: true });
      await writeFile(path.join(watchRoot, 'existing.jsonl'), '{"type":"user"}\n');
      sessionsDb.createSession('existing', 'claude', '/repo/demo', 'Existing');
      sessionsDb.createSession('during', 'claude', '/repo/demo', 'During');

      const seenByInitialScan: string[] = [];
      const state = stubSynchronizer({
        onSynchronizeSessions: async () => {
          seenByInitialScan.push(...(await readdir(watchRoot).catch(() => [])));
        },
      });
      const { client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        const initialization = initializeSessionsWatcher(watchPaths);
        await writeFile(path.join(watchRoot, 'during.jsonl'), '{"type":"user"}\n');
        await initialization;
        await waitForInitialScan(state);

        assert.ok(
          seenByInitialScan.includes('existing.jsonl'),
          'a file that existed before registration is visible to the initial scan'
        );
        assert.ok(
          seenByInitialScan.includes('during.jsonl'),
          'a file written during registration is visible to the initial scan'
        );

        sessionsDb.createSession('after-ready', 'claude', '/repo/demo', 'After ready');
        await writeFile(path.join(watchRoot, 'after-ready.jsonl'), '{"type":"user"}\n');
        const frame = await waitForFrame(5_000);
        assert.equal(frame.sessionId, 'after-ready');
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('a watched root that is absent at construction is picked up when it appears', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'late-provider-root');
      sessionsDb.createSession('late-1', 'claude', '/repo/demo', 'Late one');

      const state = stubSynchronizer();
      const { client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        await mkdir(watchRoot, { recursive: true });
        await writeFile(path.join(watchRoot, 'late-1.jsonl'), '{"type":"user"}\n');
        const frame = await waitForFrame(5_000);

        assert.equal(frame.sessionId, 'late-1');
        assert.equal(state.sessionScanCalls, 1);
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('recursive changes and atomic replacement are delivered without a full rescan', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      const nestedRoot = path.join(watchRoot, 'project-a');
      await mkdir(nestedRoot, { recursive: true });
      await writeFile(path.join(watchRoot, 'atomic-1.jsonl'), '{"type":"user"}\n');
      sessionsDb.createSession('atomic-1', 'claude', '/repo/demo', 'Atomic one');
      sessionsDb.createSession('nested-1', 'claude', '/repo/demo', 'Nested one');

      const state = stubSynchronizer();
      const { client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        const temporaryPath = path.join(watchRoot, 'atomic-1.jsonl.tmp');
        await writeFile(temporaryPath, '{"type":"assistant"}\n');
        await rename(temporaryPath, path.join(watchRoot, 'atomic-1.jsonl'));
        const atomicFrame = await waitForFrame(5_000);
        assert.equal(atomicFrame.sessionId, 'atomic-1');

        await writeFile(path.join(nestedRoot, 'nested-1.jsonl'), '{"type":"user"}\n');
        const nestedFrame = await waitForFrame(5_000);
        assert.equal(nestedFrame.sessionId, 'nested-1');

        assert.equal(state.sessionScanCalls, 1, 'file events must not trigger a full provider rescan');
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('a burst of writes is coalesced into one broadcast and bounded per-file work', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      await mkdir(watchRoot, { recursive: true });
      sessionsDb.createSession('burst-1', 'claude', '/repo/demo', 'Burst one');

      const state = stubSynchronizer();
      const { frames, client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        const target = path.join(watchRoot, 'burst-1.jsonl');
        for (let writeIndex = 0; writeIndex < 20; writeIndex += 1) {
          await writeFile(target, `{"type":"user","index":${writeIndex}}\n`);
        }

        const frame = await waitForFrame(5_000);
        assert.equal(frame.sessionId, 'burst-1');

        await delay(1_500);
        assert.equal(frames.length, 1, 'the burst produces exactly one broadcast');
        assert.equal(state.sessionScanCalls, 1, 'the burst does not trigger a full provider rescan');
        assert.ok(
          state.providerFileCalls.length >= 1 && state.providerFileCalls.length <= 20,
          `per-file syncs stay bounded by the number of writes, got ${state.providerFileCalls.length}`
        );
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('close is idempotent, cancels in-flight work, and a restart watches again', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      await mkdir(watchRoot, { recursive: true });
      sessionsDb.createSession('close-1', 'claude', '/repo/demo', 'Close one');

      let markSyncStarted: () => void = () => {};
      const syncStarted = new Promise<void>((resolve) => {
        markSyncStarted = resolve;
      });
      let releaseSync: () => void = () => {};
      const syncGate = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });

      const state = stubSynchronizer({
        synchronizeProviderFile: async (provider, filePath) => {
          markSyncStarted();
          await syncGate;
          return {
            provider,
            indexed: true,
            sessionId: path.basename(filePath, path.extname(filePath)),
          };
        },
      });
      const { frames, client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        await writeFile(path.join(watchRoot, 'close-1.jsonl'), '{"type":"user"}\n');
        await syncStarted;

        const firstClose = closeSessionsWatcher();
        const secondClose = closeSessionsWatcher();
        await Promise.all([firstClose, secondClose]);
        releaseSync();
        await delay(1_500);

        assert.equal(frames.length, 0, 'a sync that resolves after close does not broadcast');

        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state, 2);
        await writeFile(path.join(watchRoot, 'close-1.jsonl'), '{"type":"assistant"}\n');
        const frame = await waitForFrame(5_000);
        assert.equal(frame.sessionId, 'close-1');
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('a file deletion is not treated as a session update; pruning stays in the synchronizer', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const watchRoot = path.join(root, 'claude-projects');
      await mkdir(watchRoot, { recursive: true });
      const target = path.join(watchRoot, 'deleted-1.jsonl');
      await writeFile(target, '{"type":"user"}\n');
      sessionsDb.createSession('deleted-1', 'claude', '/repo/demo', 'Deleted one');

      const state = stubSynchronizer();
      const { frames, client } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: watchRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        await rm(target);
        await delay(1_500);

        assert.equal(frames.length, 0, 'unlink does not broadcast a session update');
        assert.deepEqual(state.providerFileCalls, [], 'unlink does not call the per-file synchronizer');
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});

test('a symlinked provider root is watched through its real directory', async () => {
  await withIsolatedDatabase(async () => {
    await withTempRoot(async (root) => {
      const realRoot = path.join(root, 'real-claude-projects');
      const linkedRoot = path.join(root, 'linked-claude-projects');
      await mkdir(realRoot, { recursive: true });
      await symlink(realRoot, linkedRoot, 'dir');
      sessionsDb.createSession('linked-1', 'claude', '/repo/demo', 'Linked one');

      const state = stubSynchronizer();
      const { client, waitForFrame } = addFakeClient();
      const watchPaths: SessionsWatcherPath[] = [{ provider: 'claude', rootPath: linkedRoot }];

      try {
        await initializeSessionsWatcher(watchPaths);
        await waitForInitialScan(state);

        await writeFile(path.join(realRoot, 'linked-1.jsonl'), '{"type":"user"}\n');
        const frame = await waitForFrame(5_000);
        assert.equal(frame.sessionId, 'linked-1');
      } finally {
        await closeSessionsWatcher();
        connectedClients.delete(client);
        mock.restoreAll();
      }
    });
  });
});
