import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from '../services/workspace.service.js';

test('logged checks retain output beyond maxBuffer and return only the chronological tail', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'check-log-'));
  const logPath = path.join(cwd, 'state', 'check.log');
  try {
    const result = await runCommand(process.execPath, ['-e', `
      const fs = require('node:fs');
      const line = 'x'.repeat(1023) + '\\n';
      for (let i = 0; i < 33 * 1024; i++) fs.writeSync(1, line);
      fs.writeSync(2, 'error: final stderr\\n');
      fs.writeSync(1, 'FAILED: final stdout\\n');
      process.exitCode = 17;
    `], { cwd, logPath });
    assert.equal(result.code, 17);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.split('\n').length, 60);
    assert.match(result.stdout, /error: final stderr\nFAILED: final stdout$/);
    assert.ok((await stat(logPath)).size > 32 * 1024 * 1024);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.ok(result.durationMs! >= 0);

    // A retry exposes its own log rather than appending stale failures.
    const retry = await runCommand(process.execPath, ['-e', 'console.log("passed")'], { cwd, logPath });
    assert.equal(retry.code, 0);
    assert.equal(await readFile(logPath, 'utf8'), 'passed\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('logged checks preserve spawn errors in the full log and result', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'check-spawn-'));
  const logPath = path.join(cwd, 'check.log');
  try {
    const result = await runCommand(path.join(cwd, 'missing-executable'), [], { cwd, logPath });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /ENOENT/);
    assert.match(await readFile(logPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
