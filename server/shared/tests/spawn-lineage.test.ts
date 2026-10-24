import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findSpawningProviderSessionId } from '@/shared/spawn-lineage.js';

/**
 * Builds a fake /proc tree: one directory per "process", each with an fd/
 * subdirectory of symlinks and an environ file of NUL-separated KEY=VALUE
 * records, the way the real /proc lays them out.
 */
function createFakeProc(
  processes: Array<{
    pid: number;
    fds?: Array<{ name: string; target: string }>;
    environ?: Record<string, string>;
  }>,
): string {
  const procRoot = mkdtempSync(path.join(tmpdir(), 'spawn-lineage-proc-'));
  for (const process_ of processes) {
    const pidRoot = path.join(procRoot, String(process_.pid));
    mkdirSync(path.join(pidRoot, 'fd'), { recursive: true });
    for (const fd of process_.fds ?? []) {
      symlinkSync(fd.target, path.join(pidRoot, 'fd', fd.name));
    }
    const environ = Object.entries(process_.environ ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\0');
    writeFileSync(path.join(pidRoot, 'environ'), `${environ}\0`);
  }
  return procRoot;
}

function disposeFakeProc(procRoot: string): void {
  rmSync(procRoot, { recursive: true, force: true });
}

test('findSpawningProviderSessionId returns the parent id from the process holding the transcript', () => {
  const transcript = path.join(tmpdir(), 'rollout-2026-10-24.jsonl');
  const procRoot = createFakeProc([
    {
      pid: 101,
      fds: [
        { name: '0', target: '/dev/null' },
        { name: '3', target: transcript },
      ],
      environ: { PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 'parent-provider-id' },
    },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, 'own-provider-id', { procRoot }),
      'parent-provider-id',
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId scans past processes that do not hold the transcript', () => {
  const transcript = path.join(tmpdir(), 'rollout-other.jsonl');
  const procRoot = createFakeProc([
    { pid: 201, fds: [{ name: '3', target: '/var/log/system.log' }], environ: { CLAUDE_CODE_SESSION_ID: 'not-the-parent' } },
    { pid: 202, fds: [{ name: '3', target: transcript }], environ: { HOME: '/home/user', CLAUDE_CODE_SESSION_ID: 'real-parent' } },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, undefined, { procRoot }),
      'real-parent',
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId ignores a parent id equal to the session own id', () => {
  const transcript = path.join(tmpdir(), 'rollout-self.jsonl');
  const procRoot = createFakeProc([
    {
      pid: 301,
      fds: [{ name: '3', target: transcript }],
      // The Claude process exporting its own session id is the session itself.
      environ: { CLAUDE_CODE_SESSION_ID: 'own-provider-id' },
    },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, 'own-provider-id', { procRoot }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId returns null when no process holds the transcript', () => {
  const procRoot = createFakeProc([
    { pid: 401, fds: [{ name: '3', target: '/dev/null' }], environ: { CLAUDE_CODE_SESSION_ID: 'someone-else' } },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId('/nonexistent/transcript.jsonl', undefined, { procRoot }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId returns null for a process without the environment variable', () => {
  const transcript = path.join(tmpdir(), 'rollout-noenv.jsonl');
  const procRoot = createFakeProc([
    { pid: 501, fds: [{ name: '3', target: transcript }], environ: { PATH: '/usr/bin' } },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, undefined, { procRoot }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId caps the processes scanned', () => {
  const transcript = path.join(tmpdir(), 'rollout-capped.jsonl');
  const procRoot = createFakeProc([
    { pid: 601, fds: [{ name: '3', target: transcript }], environ: { CLAUDE_CODE_SESSION_ID: 'beyond-the-cap' } },
  ]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, undefined, { procRoot, maxProcesses: 0 }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId skips processes owned by another uid', () => {
  const transcript = path.join(tmpdir(), 'rollout-foreign.jsonl');
  const procRoot = createFakeProc([
    {
      pid: 701,
      fds: [{ name: '3', target: transcript }],
      environ: { CLAUDE_CODE_SESSION_ID: 'foreign-parent' },
    },
  ]);

  try {
    // The fixture directory is owned by the test user; an unexpected getuid
    // makes every process count as foreign, as another user's would be.
    assert.equal(
      findSpawningProviderSessionId(transcript, undefined, { procRoot, getuid: () => -2 }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId returns null outside Linux', () => {
  const transcript = path.join(tmpdir(), 'rollout-anywhere.jsonl');
  const procRoot = createFakeProc([]);

  try {
    assert.equal(
      findSpawningProviderSessionId(transcript, undefined, { procRoot, platform: 'darwin' }),
      null,
    );
  } finally {
    disposeFakeProc(procRoot);
  }
});

test('findSpawningProviderSessionId returns null when the proc root is unreadable', () => {
  assert.equal(
    findSpawningProviderSessionId('/any/transcript.jsonl', undefined, {
      procRoot: '/nonexistent-proc-root',
    }),
    null,
  );
});
