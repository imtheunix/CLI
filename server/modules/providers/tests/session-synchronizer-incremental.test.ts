import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import type { IProvider } from '@/shared/interfaces.js';

// Provider synchronizers resolve `os.homedir()` when they are constructed, so
// HOME has to point at an empty fixture home before the imports below run.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-incremental-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { ClaudeSessionSynchronizer } = await import(
  '@/modules/providers/list/claude/claude-session-synchronizer.provider.js'
);
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

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-incremental-db-'));

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

function stubProvider(
  synchronize: (since?: Date) => Promise<number>,
): { calls: Array<Date | undefined>; restore: () => void } {
  const originalListProviders = providerRegistry.listProviders;
  const calls: Array<Date | undefined> = [];
  const fakeProvider = {
    id: 'claude',
    sessionSynchronizer: {
      async synchronize(since?: Date) {
        calls.push(since);
        return synchronize(since);
      },
      async synchronizeFile() {
        return null;
      },
    },
  } as unknown as IProvider;

  providerRegistry.listProviders = () => [fakeProvider];

  return {
    calls,
    restore: () => {
      providerRegistry.listProviders = originalListProviders;
    },
  };
}

test('a repeat file scan processes 0 unchanged rows and indexes a changed file once', async () => {
  await withIsolatedDatabase(async () => {
    const projectDirectory = path.join(fixtureHome, '.claude', 'projects', '-tmp-incremental-project');
    await mkdir(projectDirectory, { recursive: true });
    const transcriptPath = path.join(projectDirectory, 'session-incremental.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ sessionId: 'session-incremental', cwd: '/tmp/incremental-project' })}\n`,
    );

    const synchronizer = new ClaudeSessionSynchronizer();

    assert.equal(await synchronizer.synchronize(), 1, 'the first scan indexes the file');
    assert.equal(
      await synchronizer.synchronize(new Date(Date.now() + 1_000)),
      0,
      'an unchanged file is not reparsed',
    );

    const future = new Date(Date.now() + 2_000);
    await utimes(transcriptPath, future, future);

    assert.equal(
      await synchronizer.synchronize(new Date(Date.now() + 1_000)),
      1,
      'a file modified after the cursor is indexed once',
    );
    assert.equal(
      await synchronizer.synchronize(new Date(Date.now() + 3_000)),
      0,
      'the same change is not indexed again',
    );
  });
});

test('the persisted scan cursor survives between synchronizeSessions calls', async () => {
  await withIsolatedDatabase(async () => {
    const stub = stubProvider(async () => 0);

    try {
      await sessionSynchronizerService.synchronizeSessions();
      const firstCursor = scanStateDb.getLastScannedAt();
      assert.ok(firstCursor, 'a successful scan persists a cursor');

      await sessionSynchronizerService.synchronizeSessions();
      assert.equal(stub.calls.length, 2);
      assert.ok(stub.calls[1] instanceof Date, 'the second scan receives the persisted cursor');
      assert.ok(
        (stub.calls[1] as Date).getTime() >= firstCursor.getTime() - 1_000,
        'the second scan resumes at the persisted cursor',
      );
    } finally {
      stub.restore();
    }
  });
});

test('a failed scan does not advance the cursor', async () => {
  await withIsolatedDatabase(async () => {
    const failing = stubProvider(async () => {
      throw new Error('provider unavailable');
    });

    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(result.failures.length, 1);
      assert.equal(scanStateDb.getLastScannedAt(), null, 'a failed scan leaves the cursor unset');
    } finally {
      failing.restore();
    }

    const succeeding = stubProvider(async () => 0);
    try {
      await sessionSynchronizerService.synchronizeSessions();
      assert.equal(
        succeeding.calls[0],
        undefined,
        'the retry still starts from the beginning instead of skipping the failed window',
      );
    } finally {
      succeeding.restore();
    }
  });
});

test('a failed scan does not prune indexed sessions', async () => {
  await withIsolatedDatabase(async () => {
    const transcriptDirectory = path.join(fixtureHome, 'prune-transcripts');
    await mkdir(transcriptDirectory, { recursive: true });
    const deletedPath = path.join(transcriptDirectory, 'deleted.jsonl');
    sessionsDb.createSession('orphan-during-failure', 'claude', '/tmp/prune-project', 'Orphan', undefined, undefined, deletedPath);

    const failing = stubProvider(async () => {
      throw new Error('provider unavailable');
    });

    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(result.failures.length, 1);
      assert.equal(result.prunedOrphans, 0, 'pruning is skipped after a partial scan');
      assert.ok(
        sessionsDb.getSessionById('orphan-during-failure'),
        'a session is not deleted while another provider failed',
      );
    } finally {
      failing.restore();
    }
  });
});
