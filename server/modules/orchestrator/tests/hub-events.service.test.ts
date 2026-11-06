import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendHubEvent,
  enableLiveHubEvents,
  getHubEventsLogPath,
  getLiveHubEventsLogPath,
  isLiveHubEventsLogPath,
  isLiveHubProcess,
  isTestEnvironment,
} from '../services/hub-events.service.js';

test('appendHubEvent appends formatted single-line event to log file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-events-test-'));
  const logFile = path.join(dir, 'hub-events.log');
  const prevEnv = process.env.CLI_HUB_EVENTS_LOG;
  process.env.CLI_HUB_EVENTS_LOG = logFile;

  try {
    assert.equal(getHubEventsLogPath(), logFile);

    appendHubEvent({
      jobId: 'job-1234',
      state: 'review',
      title: 'Fix issue in parser',
      reason: 'waiting for review\nmultiline reason',
      timestamp: '2026-11-03T20:00:00.000Z',
    });

    appendHubEvent({
      jobId: 'job-5678',
      state: 'blocked',
      title: 'Add new feature\twith tabs',
      reason: 'check failed: npm test',
      timestamp: '2026-11-03T20:05:00.000Z',
    });

    const content = readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);

    const [firstLine, secondLine] = lines;
    const firstParts = firstLine.split('\t');
    assert.equal(firstParts[0], '2026-11-03T20:00:00.000Z');
    assert.equal(firstParts[1], 'job-1234');
    assert.equal(firstParts[2], 'review');
    assert.equal(firstParts[3], 'Fix issue in parser');
    assert.equal(firstParts[4], 'waiting for review multiline reason');

    const secondParts = secondLine.split('\t');
    assert.equal(secondParts[0], '2026-11-03T20:05:00.000Z');
    assert.equal(secondParts[1], 'job-5678');
    assert.equal(secondParts[2], 'blocked');
    assert.equal(secondParts[3], 'Add new feature with tabs');
    assert.equal(secondParts[4], 'check failed: npm test');
  } finally {
    if (prevEnv !== undefined) {
      process.env.CLI_HUB_EVENTS_LOG = prevEnv;
    } else {
      delete process.env.CLI_HUB_EVENTS_LOG;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('under test, hub events never go to the live log the real hub wake tails', () => {
  // Regression (2026-11-06): orchestrator tests run by the merge queue appended fixture
  // events to ~/.cache/cli/hub-events.log and the live hub was woken ~57 times.
  assert.equal(isTestEnvironment(), true, 'node --test must be detected as a test environment');
  assert.equal(isTestEnvironment({ NODE_ENV: 'test' }), true);
  assert.equal(isTestEnvironment({ NODE_ENV: 'production' }), false);

  const live = getLiveHubEventsLogPath();
  const prevEnv = process.env.CLI_HUB_EVENTS_LOG;
  try {
    delete process.env.CLI_HUB_EVENTS_LOG;
    assert.notEqual(path.resolve(getHubEventsLogPath()), live);
    assert.ok(getHubEventsLogPath().startsWith(tmpdir()));

    process.env.CLI_HUB_EVENTS_LOG = live;
    assert.notEqual(path.resolve(getHubEventsLogPath()), live, 'an inherited live CLI_HUB_EVENTS_LOG is ignored under test');
  } finally {
    if (prevEnv !== undefined) process.env.CLI_HUB_EVENTS_LOG = prevEnv;
    else delete process.env.CLI_HUB_EVENTS_LOG;
  }
});

test('only the live server opts in to the live log: enableLiveHubEvents is a no-op under test', () => {
  enableLiveHubEvents();
  assert.equal(isLiveHubProcess(), false);
  assert.equal(isLiveHubEventsLogPath(getLiveHubEventsLogPath()), true);
  assert.equal(isLiveHubEventsLogPath(path.join(path.dirname(getLiveHubEventsLogPath()), '.', 'hub-events.log')), true);
  assert.equal(isLiveHubEventsLogPath(path.join(tmpdir(), 'hub-events.log')), false);
});

test("the suite's event-producing tests, run with the live server's environment and no test runner, leave the live log untouched", () => {
  // Regression (2026-11-06, job 23cf3edb): after 59cd8214 keyed the guard on
  // NODE_TEST_CONTEXT / NODE_ENV=test, ~110 fixture events still reached the live log at
  // 13:59-14:02 UTC. A test file run directly (`tsx file.test.ts`, no --test) from a shell
  // that inherited the server's environment (NODE_ENV=production, the live DATABASE_PATH,
  // CLI_HUB_EVENTS_LOG) has no test marker; only the server's own opt-in may reach the log.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const home = mkdtempSync(path.join(tmpdir(), 'hub-events-live-shape-'));
  const liveLog = path.join(home, '.cache', 'cli', 'hub-events.log');
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      NODE_ENV: 'production',
      DATABASE_PATH: path.join(home, '.local', 'share', 'cloudcli', 'auth.db'),
      CLI_HUB_EVENTS_LOG: liveLog,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'test',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'test@example.invalid',
    };
    const result = spawnSync(
      path.join(repo, 'node_modules', '.bin', 'tsx'),
      [
        '--tsconfig', 'server/tsconfig.json',
        '--test-name-pattern', 'merged when no CI picks it up|failing checks go back to the agent',
        'server/modules/orchestrator/tests/orchestrator.test.ts',
      ],
      { cwd: repo, env, encoding: 'utf8', timeout: 120_000 },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /# tests 2\b/, output.slice(-2000));
    assert.match(output, /# pass 2\b/, output.slice(-2000));
    assert.equal(existsSync(liveLog), false, 'fixture events reached the live hub events log');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
