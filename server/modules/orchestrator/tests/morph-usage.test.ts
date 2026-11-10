import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  computeMorphUsage,
  createMorphUsageService,
  formatCompactTokens,
  formatMorphLine,
  morphModelGroup,
} from '../services/morph-usage.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import type { MorphCaps, OrchestratorConfig } from '../services/orchestrator-config.service.js';

const CAPS: MorphCaps = {
  kimi: { uncachedIn: 72_870, out: 6_162 },
  deepseek: { uncachedIn: 2_103_237, out: 76_559 },
};

function configWith(caps: MorphCaps = CAPS, admitBelow = 0.7): OrchestratorConfig {
  const config = loadOrchestratorConfig('/nonexistent/orchestrator.json');
  config.morph = { caps, admitBelow };
  return config;
}

const NOW = new Date('2026-11-10T12:00:00.000Z');
const at = (secondsAgo: number): string => new Date(NOW.getTime() - secondsAgo * 1_000).toISOString();

function ledgerLine(secondsAgo: number, model: string, uncachedIn: number, out: number, reasoning = 0): string {
  return JSON.stringify({ ts: at(secondsAgo), model, uncached_in: uncachedIn, cached_in: 9_999, out, reasoning, status: 200, wait_ms: 0, retries: 0, stream: true });
}

test('the ledger fixture: 60 s window per group, reasoning as output, the two DeepSeek ids share a cap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-ledger-'));
  const ledgerPath = path.join(root, 'ledger.jsonl');
  try {
    await writeFile(ledgerPath, [
      ledgerLine(10, 'morph/morph-dsv41flash', 1_000, 100, 50),
      ledgerLine(30, 'morph/morph-dsv41flash-1017', 2_000, 200),
      // Outside the 60 s window, inside the 15 minutes.
      ledgerLine(70, 'morph/morph-dsv41flash', 5_000, 500),
      ledgerLine(5, 'morph/morph-kimik31', 300, 30, 10),
      ledgerLine(20, 'morph/morph-kimik31', 400, 20),
      // Not a Morph model: ignored.
      ledgerLine(5, 'zai-coding-plan/glm-5.3', 9_999, 9_999),
    ].join('\n'));

    const service = createMorphUsageService({
      config: () => configWith(),
      now: () => NOW,
      ledgerPath,
      databasePath: path.join(root, 'missing.db'),
    });
    const usage = service.usage();
    assert.equal(usage.source, 'ledger');
    assert.equal(usage.groups.deepseek.uncachedIn, 3_000);
    assert.equal(usage.groups.deepseek.out, 350);
    assert.equal(usage.groups.kimi.uncachedIn, 700);
    assert.equal(usage.groups.kimi.out, 60);
    // The 70 s old request is in the minute buckets, not the rolling window.
    const deepseekMinutes = usage.groups.deepseek.minutes;
    assert.equal(deepseekMinutes.reduce((sum, minute) => sum + minute.uncachedIn, 0), 8_000);
    assert.equal(deepseekMinutes.reduce((sum, minute) => sum + minute.out, 0), 850);
    assert.equal(deepseekMinutes.length, 15);
    assert.equal(deepseekMinutes.at(-1)?.minute, '2026-11-10T12:00:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the OpenCode DB fixture: tokens.input is already uncached, reasoning as output, assistant rows only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-opencode-'));
  const databasePath = path.join(root, 'opencode.db');
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    `);
    database.prepare('INSERT INTO session (id, time_updated) VALUES (?, ?)').run('s', NOW.getTime());
    const insert = database.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    const message = (id: string, secondsAgo: number, data: Record<string, unknown>) =>
      insert.run(id, 's', NOW.getTime() - secondsAgo * 1_000, NOW.getTime() - secondsAgo * 1_000, JSON.stringify(data));
    message('a', 10, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-dsv41flash',
      tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 400, write: 0 } },
    });
    message('b', 20, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-kimik31',
      tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 100, write: 0 } },
    });
    // A heavy-cache turn: cache.read is larger than the uncached input and must not be subtracted.
    message('e', 15, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-dsv41flash',
      tokens: { input: 2_000, output: 0, reasoning: 0, cache: { read: 48_000, write: 0 } },
    });
    // A user message with tokens is not usage.
    message('c', 5, { role: 'user', tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0 } } });
    // Older than 15 minutes: ignored.
    message('d', 16 * 60, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-dsv41flash',
      tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0 } },
    });
  } finally {
    database.close();
  }

  try {
    const service = createMorphUsageService({
      config: () => configWith(),
      now: () => NOW,
      ledgerPath: path.join(root, 'missing.jsonl'),
      databasePath,
    });
    const usage = service.usage();
    assert.equal(usage.source, 'opencode');
    // 1,000 + 2,000: tokens.input is already uncached, so cache.read is not subtracted again.
    assert.equal(usage.groups.deepseek.uncachedIn, 3_000);
    assert.equal(usage.groups.deepseek.out, 150);
    assert.equal(usage.groups.kimi.uncachedIn, 500);
    assert.equal(usage.groups.kimi.out, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the OpenCode fallback counts only Morph messages and uses completion time for the window', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-opencode-time-'));
  const databasePath = path.join(root, 'opencode.db');
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    `);
    database.prepare('INSERT INTO session (id, time_updated) VALUES (?, ?)').run('s', NOW.getTime());
    const insert = database.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    const message = (id: string, createdAgo: number, data: Record<string, unknown>) =>
      insert.run(id, 's', NOW.getTime() - createdAgo * 1_000, NOW.getTime() - createdAgo * 1_000, JSON.stringify(data));
    // Created 90 s ago, completed 2 s ago: a long stream belongs to the window it actually loaded.
    message('long', 90, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-dsv41flash',
      time: { created: NOW.getTime() - 90_000, completed: NOW.getTime() - 2_000 },
      tokens: { input: 1_000, output: 70_000, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // Another provider's assistant message with a Morph-looking model id is not Morph usage.
    message('foreign', 2, {
      role: 'assistant', providerID: 'zai', modelID: 'deepseek-v4',
      time: { created: NOW.getTime() - 2_000, completed: NOW.getTime() - 2_000 },
      tokens: { input: 9_999, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // No completion time: falls back to creation time.
    message('created', 3, {
      role: 'assistant', providerID: 'morph', modelID: 'morph-dsv41flash',
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  } finally {
    database.close();
  }

  try {
    const service = createMorphUsageService({
      config: () => configWith(),
      now: () => NOW,
      ledgerPath: path.join(root, 'missing.jsonl'),
      databasePath,
    });
    const usage = service.usage();
    assert.equal(usage.source, 'opencode');
    assert.equal(usage.groups.deepseek.uncachedIn, 1_010);
    assert.equal(usage.groups.deepseek.out, 70_005);
    // The long stream is over the admission threshold, so admission holds.
    assert.equal(service.admitted(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale ledger falls back to OpenCode; a missing one reports no source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-fallback-'));
  const ledgerPath = path.join(root, 'ledger.jsonl');
  try {
    // Only lines older than 10 minutes: the ledger is not authoritative.
    await writeFile(ledgerPath, ledgerLine(11 * 60, 'morph/morph-dsv41flash', 1_000, 100));
    const service = createMorphUsageService({
      config: () => configWith(),
      now: () => NOW,
      ledgerPath,
      databasePath: path.join(root, 'missing.db'),
    });
    const usage = service.usage();
    assert.equal(usage.source, 'none');
    assert.equal(usage.groups.deepseek.uncachedIn, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admission fails closed when an existing input is unreadable or stale, but admits a fresh machine', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-none-'));
  const ledgerPath = path.join(root, 'ledger.jsonl');
  const databasePath = path.join(root, 'opencode.db');
  const service = () => createMorphUsageService({
    config: () => configWith(),
    now: () => NOW,
    ledgerPath,
    databasePath,
  });
  try {
    // Fresh machine: neither the ledger nor the OpenCode database exists.
    assert.equal(service().usage().source, 'none');
    assert.equal(service().admitted(), true);

    // A stale ledger is an existing input: headroom is unknown, so admission holds.
    await writeFile(ledgerPath, ledgerLine(11 * 60, 'morph/morph-dsv41flash', 1_000, 100));
    assert.equal(service().usage().source, 'none');
    assert.equal(service().admitted(), false);

    // An unreadable ledger (a directory here) is a read failure, not a fresh machine.
    await rm(ledgerPath, { force: true });
    await mkdir(ledgerPath);
    assert.equal(service().admitted(), false);
    await rm(ledgerPath, { recursive: true, force: true });

    // An unreadable OpenCode database (garbage, not SQLite) is a read failure too.
    await writeFile(databasePath, 'not a sqlite database');
    assert.equal(service().usage().source, 'none');
    assert.equal(service().admitted(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nonfinite cap values from orchestrator.json are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-caps-'));
  const file = path.join(root, 'orchestrator.json');
  try {
    // JSON has no Infinity literal, but 1e999 overflows to it.
    await writeFile(file, '{"morph":{"caps":{"kimi":{"uncachedIn":1e999},"deepseek":{"out":1e999}}}}');
    const config = loadOrchestratorConfig(file);
    assert.equal(config.morph.caps.kimi.uncachedIn, 72_870);
    assert.equal(config.morph.caps.deepseek.out, 76_559);
    assert.equal(config.morph.admitBelow, 0.7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model grouping and the compact CLI line', () => {
  assert.equal(morphModelGroup('morph/morph-kimik31'), 'kimi');
  assert.equal(morphModelGroup('morph/morph-dsv41flash'), 'deepseek');
  assert.equal(morphModelGroup('morph/morph-dsv41flash-1017'), 'deepseek');
  assert.equal(morphModelGroup('zai-coding-plan/glm-5.3'), null);

  assert.equal(formatCompactTokens(3_100), '3.1k');
  assert.equal(formatCompactTokens(41_000), '41k');
  assert.equal(formatCompactTokens(72_870), '72.9k');
  assert.equal(formatCompactTokens(400_000), '0.4M');
  assert.equal(formatCompactTokens(2_103_237), '2.1M');
  assert.equal(formatCompactTokens(999), '999');

  const usage = computeMorphUsage([
    { ts: NOW.getTime() - 1_000, model: 'morph/morph-kimik31', uncachedIn: 41_000, out: 3_100 },
    { ts: NOW.getTime() - 1_000, model: 'morph/morph-dsv41flash', uncachedIn: 400_000, out: 38_000 },
  ], CAPS, NOW, 'ledger');
  assert.equal(
    formatMorphLine(usage),
    'morph: kimi out 3.1k/6.2k in 41k/72.9k | deepseek out 38k/76.6k in 0.4M/2.1M',
  );
});

test('admission holds while the DeepSeek output window is at or above admitBelow of its cap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'morph-usage-admit-'));
  const ledgerPath = path.join(root, 'ledger.jsonl');
  try {
    const service = (out: number) => {
      return createMorphUsageService({
        config: () => configWith(),
        now: () => NOW,
        ledgerPath,
        databasePath: path.join(root, 'missing.db'),
      });
    };
    // 0.7 * 76,559 = 53,591.3: below admits, at/above holds.
    await writeFile(ledgerPath, ledgerLine(1, 'morph/morph-dsv41flash', 0, 53_591));
    assert.equal(service(53_591).admitted(), true);
    await writeFile(ledgerPath, ledgerLine(1, 'morph/morph-dsv41flash', 0, 53_592));
    assert.equal(service(53_592).admitted(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
