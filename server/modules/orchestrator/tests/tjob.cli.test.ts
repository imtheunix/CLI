import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const tjobScript = path.join(applicationRoot, 'scripts', 'tjob');

type TjobResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs the real `scripts/tjob` against a fake curl, so the test covers the
 * script's own exit status rather than a mocked API client.
 */
function runTjob(args: string[], options: { body?: string; curlExit?: number } = {}): TjobResult {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tjob-cli-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    mkdirSync(path.join(home, '.cloudcli'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(home, '.cloudcli', 'local-server.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }));
    writeFileSync(path.join(home, '.cloudcli', 'orchestrator.token'), 'test-token\n');
    const fakeCurl = path.join(bin, 'curl');
    writeFileSync(
      fakeCurl,
      [
        '#!/usr/bin/env bash',
        'cat >/dev/null',
        'if [ -n "${TJBODY:-}" ]; then printf \'%s\' "$TJBODY"; fi',
        'if [ "${TJEXIT:-0}" -ne 0 ]; then echo "curl: (${TJEXIT}) fake transport failure" >&2; fi',
        'exit "${TJEXIT:-0}"',
        '',
      ].join('\n'),
    );
    chmodSync(fakeCurl, 0o755);

    const result = spawnSync('bash', [tjobScript, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TJBODY: options.body ?? '',
        TJEXIT: String(options.curlExit ?? 0),
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hubBody = JSON.stringify({
  success: true,
  data: { hub: { sessionId: 'sess-1', provider: 'opencode', model: 'morph/morph-kimik31', effort: 'low', agent: 'morph-hub', wake: true } },
});
const lsBody = JSON.stringify({ success: true, data: { loads: {}, caps: {}, jobs: [] } });
const apiFailureBody = JSON.stringify({ success: false, error: { message: 'boom' } });

test('tjob hub exits 0 on an HTTP 200 empty-body GET', () => {
  const result = runTjob(['hub'], { body: hubBody });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session: sess-1/);
});

test('tjob ls exits 0 on an HTTP 200 empty-body GET', () => {
  const result = runTjob(['ls'], { body: lsBody });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude: 0\/0/);
});

test('tjob hub exits nonzero when the API reports failure', () => {
  const result = runTjob(['hub'], { body: apiFailureBody });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tjob: boom/);
});

test('tjob ls exits nonzero when the API reports failure', () => {
  const result = runTjob(['ls'], { body: apiFailureBody });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tjob: boom/);
});

test('tjob hub exits nonzero when the transport fails', () => {
  const result = runTjob(['hub'], { curlExit: 7 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake transport failure/);
});

test('tjob ls exits nonzero when the transport fails', () => {
  const result = runTjob(['ls'], { curlExit: 7 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake transport failure/);
});
