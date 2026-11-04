import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDatabasePath, guardTestDatabasePath } from '@/modules/database/connection.js';

const LIVE_PATH = '/home/cloudcli-live/.local/share/cloudcli/auth.db';

test('a test run never resolves the live database, even when the live DATABASE_PATH is inherited', () => {
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = LIVE_PATH;
  try {
    const resolved = getDatabasePath();
    assert.notEqual(resolved, LIVE_PATH);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), resolved);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
  }
});

test('the guard keeps scratch paths and only applies under the test runner', () => {
  const scratch = path.join(os.tmpdir(), 'cbc-guard', 'auth.db');
  assert.equal(guardTestDatabasePath(scratch, { NODE_TEST_CONTEXT: 'child-v8' }), scratch);
  assert.equal(guardTestDatabasePath(':memory:', { NODE_TEST_CONTEXT: 'child-v8' }), ':memory:');
  assert.equal(guardTestDatabasePath(LIVE_PATH, {}), LIVE_PATH);
  assert.notEqual(guardTestDatabasePath(LIVE_PATH, { NODE_TEST_CONTEXT: 'child-v8' }), LIVE_PATH);
});
