import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isTurnAlive, resetSystemdRunCache, tailLogFile } from '../index.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'detached-liveness-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
}

test('isTurnAlive probes systemctl asynchronously and shares one probe per unit', async () => {
  await withTempDir(async (root) => {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const counter = path.join(root, 'systemctl-calls');
    writeExecutable(path.join(bin, 'systemd-run'), '#!/bin/sh\nexit 0\n');
    writeExecutable(
      path.join(bin, 'systemctl'),
      `#!/bin/sh
if [ "$2" = "is-active" ]; then
  echo x >> "$COUNTER_FILE"
  sleep 0.3
  echo active
  exit 0
fi
exit 1
`,
    );

    const previousPath = process.env.PATH;
    const previousCounter = process.env.COUNTER_FILE;
    const previousDisable = process.env.CLI_DISABLE_SYSTEMD_RUN;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.COUNTER_FILE = counter;
    delete process.env.CLI_DISABLE_SYSTEMD_RUN;
    resetSystemdRunCache();

    try {
      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 50);
      const [first, second] = await Promise.all([isTurnAlive('unit-slow'), isTurnAlive('unit-slow')]);
      clearTimeout(timer);

      assert.equal(first, true);
      assert.equal(second, true);
      assert.equal(timerFired, true, 'the event loop stayed responsive while systemctl ran');
      assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'concurrent checks share one probe');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCounter === undefined) delete process.env.COUNTER_FILE;
      else process.env.COUNTER_FILE = previousCounter;
      if (previousDisable === undefined) delete process.env.CLI_DISABLE_SYSTEMD_RUN;
      else process.env.CLI_DISABLE_SYSTEMD_RUN = previousDisable;
      resetSystemdRunCache();
    }
  });
});

test('tailLogFile stops polling once the unit is gone and drains the final output', async () => {
  await withTempDir(async (root) => {
    const logPath = path.join(root, 'turn.log');
    writeFileSync(logPath, 'one\ntwo\n');

    let calls = 0;
    const lines: string[] = [];
    const offset = await tailLogFile(logPath, {
      isAlive: async () => {
        calls += 1;
        return calls < 3;
      },
      onLine: (line) => lines.push(line),
      pollIntervalMs: 10,
    });

    assert.deepEqual(lines, ['one', 'two']);
    assert.equal(offset, 8);
    const callsAtEnd = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, callsAtEnd, 'no polling after completion');
  });
});

test('tailLogFile stops polling when a liveness check throws', async () => {
  await withTempDir(async (root) => {
    const logPath = path.join(root, 'turn.log');
    writeFileSync(logPath, 'one\n');

    let calls = 0;
    await assert.rejects(
      tailLogFile(logPath, {
        isAlive: () => {
          calls += 1;
          if (calls === 2) throw new Error('liveness boom');
          return true;
        },
        onLine: () => {},
        pollIntervalMs: 10,
      }),
      /liveness boom/,
    );

    const callsAtEnd = calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, callsAtEnd, 'no polling after the error');
  });
});
