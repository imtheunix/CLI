import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareZcodeHome } from '../list/zcode/zcode-home.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-home-test-'));
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

/** A source home whose shared credentials are a real file, so the shadow home links them. */
async function makeSourceHome(root: string): Promise<string> {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(source, '.zcode', 'v2', 'credentials.json'), '{"token":"shared"}');
  writeFileSync(path.join(source, '.zcode', 'v2', 'provider_config.json'), '{"model":"glm"}');
  return source;
}

test('prepareZcodeHome runs the API-key login without blocking the event loop', async () => {
  await withTempDir(async (root) => {
    const source = await makeSourceHome(root);
    const home = path.join(root, 'home');
    const marker = path.join(root, 'login-done');
    const script = path.join(root, 'login.cjs');
    writeFileSync(
      script,
      `const fs = require('node:fs');
setTimeout(() => { fs.writeFileSync(process.env.LOGIN_MARKER, 'done'); }, 300);
`,
    );

    const previousNodeEnv = process.env.NODE_ENV;
    const previousScript = process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
    const previousMarker = process.env.LOGIN_MARKER;
    process.env.NODE_ENV = 'development';
    process.env.ZCODE_APIKEY_LOGIN_SCRIPT = script;
    process.env.LOGIN_MARKER = marker;

    try {
      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 50);
      const prepared = await prepareZcodeHome(home, source);
      clearTimeout(timer);

      assert.equal(prepared, home);
      assert.equal(timerFired, true, 'the event loop stayed responsive while the login ran');
      assert.equal(existsSync(marker), true, 'the login finished before the home was returned');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousScript === undefined) delete process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
      else process.env.ZCODE_APIKEY_LOGIN_SCRIPT = previousScript;
      if (previousMarker === undefined) delete process.env.LOGIN_MARKER;
      else process.env.LOGIN_MARKER = previousMarker;
    }
  });
});

test('concurrent preparations of one shadow home share a single login', async () => {
  await withTempDir(async (root) => {
    const source = await makeSourceHome(root);
    const home = path.join(root, 'home');
    const counter = path.join(root, 'login-count');
    const script = path.join(root, 'login.cjs');
    writeFileSync(
      script,
      `const fs = require('node:fs');
fs.appendFileSync(process.env.LOGIN_COUNTER, 'x');
setTimeout(() => {}, 200);
`,
    );

    const previousNodeEnv = process.env.NODE_ENV;
    const previousScript = process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
    const previousCounter = process.env.LOGIN_COUNTER;
    process.env.NODE_ENV = 'development';
    process.env.ZCODE_APIKEY_LOGIN_SCRIPT = script;
    process.env.LOGIN_COUNTER = counter;

    try {
      const [first, second] = await Promise.all([
        prepareZcodeHome(home, source),
        prepareZcodeHome(home, source),
      ]);
      assert.equal(first, home);
      assert.equal(second, home);
      assert.equal(readFileSync(counter, 'utf8'), 'x', 'one login for concurrent preparations');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousScript === undefined) delete process.env.ZCODE_APIKEY_LOGIN_SCRIPT;
      else process.env.ZCODE_APIKEY_LOGIN_SCRIPT = previousScript;
      if (previousCounter === undefined) delete process.env.LOGIN_COUNTER;
      else process.env.LOGIN_COUNTER = previousCounter;
    }
  });
});
