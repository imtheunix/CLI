import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { IProvider } from '@/shared/interfaces.js';

// Each provider synchronizer resolves `os.homedir()` when the registry module is
// first imported, so HOME has to point at an empty fixture home *before* that
// import runs. Otherwise the sync pass walks the developer's real ~/.claude.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-prune-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { providerRegistry } = await import('@/modules/providers/provider.registry.js');
const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
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

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prune-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
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

const PROJECT_PATH = '/tmp/session-prune-project';

function stubProvider(): { restore: () => void } {
  const originalListProviders = providerRegistry.listProviders;
  const fakeProvider = {
    id: 'claude',
    sessionSynchronizer: {
      async synchronize() {
        return 0;
      },
      async synchronizeFile() {
        return null;
      },
    },
  } as unknown as IProvider;

  providerRegistry.listProviders = () => [fakeProvider];

  return {
    restore: () => {
      providerRegistry.listProviders = originalListProviders;
    },
  };
}

type FsCounters = { access: number; stat: number; readdir: number };

/**
 * Counts the filesystem calls the prune pass makes. The service imports the
 * default `node:fs` object, so replacing its `promises` methods observes the
 * real calls without relying on wall-clock timing.
 */
function instrumentFs(): { counters: FsCounters; restore: () => void } {
  const promises = fs.promises as unknown as {
    access: (...args: unknown[]) => Promise<unknown>;
    stat: (...args: unknown[]) => Promise<unknown>;
    readdir: (...args: unknown[]) => Promise<unknown>;
  };
  const original = {
    access: promises.access,
    stat: promises.stat,
    readdir: promises.readdir,
  };
  const counters: FsCounters = { access: 0, stat: 0, readdir: 0 };

  promises.access = async (...args: unknown[]) => {
    counters.access += 1;
    return original.access(...args);
  };
  promises.stat = async (...args: unknown[]) => {
    counters.stat += 1;
    return original.stat(...args);
  };
  promises.readdir = async (...args: unknown[]) => {
    counters.readdir += 1;
    return original.readdir(...args);
  };

  return {
    counters,
    restore: () => {
      promises.access = original.access;
      promises.stat = original.stat;
      promises.readdir = original.readdir;
    },
  };
}

test('synchronizeSessions drops indexed sessions whose transcript file was deleted', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'transcripts');
    await mkdir(transcriptDirectory, { recursive: true });

    const livePath = path.join(transcriptDirectory, 'live.jsonl');
    await writeFile(livePath, '{}\n');
    const deletedPath = path.join(transcriptDirectory, 'deleted.jsonl');

    sessionsDb.createSession('live-session', 'claude', PROJECT_PATH, 'Live', undefined, undefined, livePath);
    sessionsDb.createSession('orphan-session', 'claude', PROJECT_PATH, 'Untitled Claude Session', undefined, undefined, deletedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(result.failures, []);
    assert.equal(result.prunedOrphans, 1);
    assert.equal(sessionsDb.getSessionById('orphan-session'), null);
    assert.ok(sessionsDb.getSessionById('live-session'), 'a session whose transcript still exists must survive');
  });
});

test('synchronizeSessions keeps sessions whose whole transcript directory is missing', async () => {
  await withIsolatedDatabase(async (workspace) => {
    // Stands in for an unmounted or not-yet-created home: every transcript
    // "looks" deleted, so pruning here would wipe the entire index.
    const unmountedPath = path.join(workspace, 'not-mounted', 'session.jsonl');

    sessionsDb.createSession('unmounted-session', 'claude', PROJECT_PATH, 'Unmounted', undefined, undefined, unmountedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('unmounted-session'));
  });
});

test('synchronizeSessions keeps sessions that have no transcript path yet', async () => {
  await withIsolatedDatabase(async () => {
    // App-created rows (jsonl_path NULL until the first provider write) and
    // OpenCode rows (one shared sqlite file, so jsonl_path stays NULL).
    sessionsDb.createAppSession('pending-app-session', 'claude', PROJECT_PATH, 'Pending');
    sessionsDb.createSession('opencode-session', 'opencode', PROJECT_PATH, 'OpenCode', undefined, undefined, null);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('pending-app-session'));
    assert.ok(sessionsDb.getSessionById('opencode-session'));
  });
});

test('an unchanged project costs one directory stat and zero per-file probes', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'many-transcripts');
    await mkdir(transcriptDirectory, { recursive: true });

    const fileCount = 200;
    for (let index = 0; index < fileCount; index += 1) {
      const filePath = path.join(transcriptDirectory, `session-${index}.jsonl`);
      await writeFile(filePath, '{}\n');
      sessionsDb.createSession(
        `session-${index}`,
        'claude',
        PROJECT_PATH,
        `Session ${index}`,
        undefined,
        undefined,
        filePath,
      );
    }

    // Make the directory look settled so the coarse-timestamp guard trusts the
    // first manifest on the immediately following sync.
    const settled = new Date(Date.now() - 60_000);
    await utimes(transcriptDirectory, settled, settled);

    const provider = stubProvider();
    const instrumentation = instrumentFs();

    try {
      const first = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(first.prunedOrphans, 0);
      assert.equal(instrumentation.counters.access, 0, 'present files are not probed individually');
      assert.equal(instrumentation.counters.readdir, 1, 'the directory is listed once');
      assert.equal(instrumentation.counters.stat, 1, 'the directory is statted once');

      instrumentation.counters.access = 0;
      instrumentation.counters.stat = 0;
      instrumentation.counters.readdir = 0;

      const second = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(second.prunedOrphans, 0);
      assert.equal(instrumentation.counters.access, 0, 'unchanged files need zero per-file access calls');
      assert.equal(instrumentation.counters.readdir, 0, 'an unchanged directory is not re-listed');
      assert.equal(instrumentation.counters.stat, 1, 'only the directory identity is revalidated');
    } finally {
      instrumentation.restore();
      provider.restore();
    }
  });
});

test('a deleted transcript is pruned and a recreated one is kept', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'recreated');
    await mkdir(transcriptDirectory, { recursive: true });

    const livePath = path.join(transcriptDirectory, 'live.jsonl');
    const deletedPath = path.join(transcriptDirectory, 'deleted.jsonl');
    await writeFile(livePath, '{}\n');
    await writeFile(deletedPath, '{}\n');

    sessionsDb.createSession('live-session', 'claude', PROJECT_PATH, 'Live', undefined, undefined, livePath);
    sessionsDb.createSession('deleted-session', 'claude', PROJECT_PATH, 'Deleted', undefined, undefined, deletedPath);

    const provider = stubProvider();

    try {
      const first = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(first.prunedOrphans, 0);

      await rm(deletedPath);
      const second = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(second.prunedOrphans, 1);
      assert.equal(sessionsDb.getSessionById('deleted-session'), null);
      assert.ok(sessionsDb.getSessionById('live-session'), 'the live row in the same directory survives');

      await writeFile(deletedPath, '{}\n');
      sessionsDb.createSession('deleted-session', 'claude', PROJECT_PATH, 'Deleted', undefined, undefined, deletedPath);

      const third = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(third.prunedOrphans, 0);
      assert.ok(sessionsDb.getSessionById('deleted-session'), 'a recreated transcript is not pruned');
    } finally {
      provider.restore();
    }
  });
});

test('a directory that cannot be listed keeps every row in it', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'unreadable');
    await mkdir(transcriptDirectory, { recursive: true });

    const firstPath = path.join(transcriptDirectory, 'first.jsonl');
    const secondPath = path.join(transcriptDirectory, 'second.jsonl');
    sessionsDb.createSession('first-session', 'claude', PROJECT_PATH, 'First', undefined, undefined, firstPath);
    sessionsDb.createSession('second-session', 'claude', PROJECT_PATH, 'Second', undefined, undefined, secondPath);

    const provider = stubProvider();
    const promises = fs.promises as unknown as {
      readdir: (...args: unknown[]) => Promise<unknown>;
    };
    const originalReaddir = promises.readdir;
    promises.readdir = async () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };

    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(result.prunedOrphans, 0);
      assert.ok(sessionsDb.getSessionById('first-session'));
      assert.ok(sessionsDb.getSessionById('second-session'));
    } finally {
      promises.readdir = originalReaddir;
      provider.restore();
    }
  });
});
