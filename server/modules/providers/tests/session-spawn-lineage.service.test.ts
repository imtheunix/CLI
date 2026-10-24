import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { findSpawnParentForNewSession } from '@/modules/providers/services/session-spawn-lineage.service.js';

/**
 * The lineage service turns "a process holds this transcript open and its
 * environment names a Claude session" into "this app session is the parent",
 * skipping sessions the index already knows and failing open on every error.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'spawn-lineage-service-'));

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
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

/** One fake process holding the transcript open with a CLAUDE_CODE_SESSION_ID environment. */
function createFakeProc(transcriptPath: string, parentProviderSessionId: string): string {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'spawn-lineage-service-proc-'));
  const pidRoot = path.join(procRoot, '4242');
  mkdirSync(path.join(pidRoot, 'fd'), { recursive: true });
  symlinkSync(transcriptPath, path.join(pidRoot, 'fd', '3'));
  writeFileSync(path.join(pidRoot, 'environ'), `HOME=/home/user\0CLAUDE_CODE_SESSION_ID=${parentProviderSessionId}\0`);
  return procRoot;
}

test('findSpawnParentForNewSession resolves the spawning parent app session for a new transcript', async () => {
  await withIsolatedDatabase(async () => {
    // The parent is an app-created Claude session: its app id differs from its
    // provider id, and that app id is what must be stored.
    sessionsDb.createAppSession('parent-app-id', 'claude', '/repo/demo', 'Fix the login flow');
    sessionsDb.assignProviderSessionId('parent-app-id', 'parent-provider-id');

    const transcript = path.join(tmpdir(), 'rollout-service-1.jsonl');
    const procRoot = createFakeProc(transcript, 'parent-provider-id');

    try {
      const parent = findSpawnParentForNewSession(
        { providerSessionId: 'child-provider-id', transcriptPath: transcript },
        { procRoot },
      );
      assert.equal(parent, 'parent-app-id');
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});

test('findSpawnParentForNewSession skips a session the index already knows', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('parent-app-id', 'claude', '/repo/demo', 'Parent');
    sessionsDb.assignProviderSessionId('parent-app-id', 'parent-provider-id');
    sessionsDb.createSession('known-child', 'codex', '/repo/demo', 'Already indexed');

    const transcript = path.join(tmpdir(), 'rollout-service-2.jsonl');
    const procRoot = createFakeProc(transcript, 'parent-provider-id');

    try {
      const parent = findSpawnParentForNewSession(
        { providerSessionId: 'known-child', transcriptPath: transcript },
        { procRoot },
      );
      assert.equal(parent, null, 'an already-indexed session keeps whatever lineage it has');
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});

test('findSpawnParentForNewSession returns null without a transcript path or an indexed parent', async () => {
  await withIsolatedDatabase(async () => {
    assert.equal(
      findSpawnParentForNewSession({ providerSessionId: 'any', transcriptPath: null }),
      null,
      'OpenCode-style sessions share one sqlite file, so there is no transcript to find',
    );

    const transcript = path.join(tmpdir(), 'rollout-service-3.jsonl');
    const procRoot = createFakeProc(transcript, 'parent-not-in-index');

    try {
      const parent = findSpawnParentForNewSession(
        { providerSessionId: 'child-provider-id', transcriptPath: transcript },
        { procRoot },
      );
      assert.equal(parent, null, 'a parent the index does not know cannot be stored');
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});

test('findSpawnParentForNewSession never throws when detection fails', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(
      findSpawnParentForNewSession(
        { providerSessionId: 'child', transcriptPath: '/any/transcript.jsonl' },
        { procRoot: '/nonexistent-proc-root' },
      ),
      null,
    );
  });
});
