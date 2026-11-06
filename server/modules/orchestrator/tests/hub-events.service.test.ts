import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  appendHubEvent,
  getHubEventsLogPath,
  getLiveHubEventsLogPath,
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
