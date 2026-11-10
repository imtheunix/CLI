import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FakeClock } from '../src/clock.js';
import { DEFAULT_CONFIG, DEFAULT_GROUPS, loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { Pacer } from '../src/pacer.js';

const directory = mkdtempSync(join(tmpdir(), 'morph-pacer-config-test-'));

function writeConfig(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function withApiKey(): void {
  process.env.MORPH_API_KEY = 'test-key';
  delete process.env.MORPH_PACER_HOST;
  delete process.env.MORPH_PACER_PORT;
  delete process.env.MORPH_PACER_UPSTREAM;
  delete process.env.MORPH_PACER_API_KEY_FILE;
  delete process.env.MORPH_PACER_LEDGER;
}

test('defaults to port 8198 so it does not collide with CloudCLI on 8197', () => {
  assert.equal(DEFAULT_CONFIG.port, 8198);
});

test('deep-merges a caps-only group override and keeps the default models', () => {
  withApiKey();
  const config = loadConfig(
    writeConfig('caps-only.json', {
      groups: { kimik31: { caps: { uncachedIn: 10, out: 5 } } },
    }),
  );
  assert.deepEqual(config.groups.kimik31.models, DEFAULT_GROUPS.kimik31.models);
  assert.deepEqual(config.groups.kimik31.caps, { uncachedIn: 10, out: 5 });
  assert.doesNotThrow(() => new Pacer(config, new FakeClock(), silentLogger));
});

test('deep-merges a models-only group override and keeps the default caps', () => {
  withApiKey();
  const config = loadConfig(
    writeConfig('models-only.json', {
      groups: { kimik31: { models: ['morph-kimik31'] } },
    }),
  );
  assert.deepEqual(config.groups.kimik31.models, ['morph-kimik31']);
  assert.deepEqual(config.groups.kimik31.caps, DEFAULT_GROUPS.kimik31.caps);
  assert.doesNotThrow(() => new Pacer(config, new FakeClock(), silentLogger));
});

test('an uncachedIn-only cap override does not disable the output cap', () => {
  withApiKey();
  const config = loadConfig(
    writeConfig('uncached-only.json', {
      groups: { kimik31: { caps: { uncachedIn: 10 } } },
    }),
  );
  assert.equal(config.groups.kimik31.caps.uncachedIn, 10);
  assert.equal(config.groups.kimik31.caps.out, DEFAULT_GROUPS.kimik31.caps.out);
});

test('rejects a group with an empty models array at startup', () => {
  withApiKey();
  assert.throws(
    () =>
      loadConfig(
        writeConfig('empty-models.json', {
          groups: { kimik31: { models: [] } },
        }),
      ),
    /non-empty models array/,
  );
});

test('rejects a group with a non-positive or non-finite cap at startup', () => {
  withApiKey();
  assert.throws(
    () =>
      loadConfig(
        writeConfig('zero-cap.json', {
          groups: { kimik31: { caps: { uncachedIn: 0, out: 5 } } },
        }),
      ),
    /finite positive number/,
  );
  assert.throws(
    () =>
      loadConfig(
        writeConfig('nan-cap.json', {
          groups: { kimik31: { caps: { uncachedIn: 10, out: Number.NaN } } },
        }),
      ),
    /finite positive number/,
  );
});

test('rejects an upstream that is not an absolute http(s) URL at startup', () => {
  withApiKey();
  assert.throws(
    () => loadConfig(writeConfig('bad-upstream.json', { upstream: 'not a url' })),
    /absolute URL/,
  );
  assert.throws(
    () => loadConfig(writeConfig('bad-scheme.json', { upstream: 'ftp://example.com/v1' })),
    /http or https/,
  );
});
