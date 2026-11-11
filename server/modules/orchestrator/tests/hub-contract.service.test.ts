import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { appendHubEvent, onHubEvent } from '../services/hub-events.service.js';
import { countHubWrites, createHubContractService, HUB_WRITES_EVENT_GAP_MS } from '../services/hub-contract.service.js';
import type { HubEventInput } from '../services/hub-events.service.js';

/** An OpenCode-shaped database with the two tables hub-contract reads: session and part. */
function fixtureDatabase(dir: string, rows: Array<{ agent: string | null; parent: string | null; parts: Array<{ type: string; tool?: string; at: number }> }>): string {
  const file = path.join(dir, `opencode-${Math.random().toString(36).slice(2)}.db`);
  const database = new Database(file);
  database.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, time_updated INTEGER)');
  database.exec('CREATE TABLE part (session_id TEXT, time_created INTEGER, data TEXT)');
  let session = 0;
  for (const row of rows) {
    const id = `ses_${session++}`;
    database.prepare('INSERT INTO session (id, parent_id, agent, time_updated) VALUES (?, ?, ?, ?)').run(id, row.parent, row.agent, 1);
    for (const part of row.parts) {
      const data = part.type === 'tool' ? JSON.stringify({ type: 'tool', tool: part.tool ?? 'edit' }) : JSON.stringify({ type: part.type });
      database.prepare('INSERT INTO part (session_id, time_created, data) VALUES (?, ?, ?)').run(id, part.at, data);
    }
  }
  database.close();
  return file;
}

const T0 = 1_700_000_000_000;

test('the hub contract service counts only the hub\'s own edits in the window', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hub-contract-'));
  t.after(async () => { const { rmSync } = await import('node:fs'); rmSync(dir, { recursive: true, force: true }); });
  const file = fixtureDatabase(dir, [
    { agent: 'morph-hub', parent: null, parts: [
      { type: 'tool', tool: 'edit', at: T0 + 1 },
      { type: 'tool', tool: 'write', at: T0 + 2 },
      { type: 'tool', tool: 'read', at: T0 + 3 },
      { type: 'tool', tool: 'edit', at: T0 - 61 * 60_000 },  // before the window
    ] },
    { agent: 'morph-worker', parent: null, parts: [{ type: 'tool', tool: 'edit', at: T0 + 4 }] },   // not the hub
    { agent: 'morph-hub', parent: 'ses_0', parts: [{ type: 'tool', tool: 'edit', at: T0 + 5 }] },   // a subagent, not the hub session
  ]);
  assert.equal(countHubWrites(file, T0 - 60 * 60_000, T0 + 60_000), 2);
  assert.equal(countHubWrites(path.join(dir, 'missing.db'), 0, 1), 0);
});

test('a writing hub is corrected once per hour, a clean hub is not', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hub-contract-'));
  t.after(async () => { const { rmSync } = await import('node:fs'); rmSync(dir, { recursive: true, force: true }); });
  const file = fixtureDatabase(dir, [
    { agent: 'morph-hub', parent: null, parts: [{ type: 'tool', tool: 'edit', at: T0 - 1_000 }] },
  ]);
  const events: HubEventInput[] = [];
  const unsubscribe = onHubEvent((event) => events.push(event));
  t.after(() => unsubscribe());

  let nowMs = T0;
  let counted = 0;
  const service = createHubContractService({
    now: () => new Date(nowMs),
    databasePath: file,
    readCount: (_databasePath, sinceMs, untilMs) => {
      counted += 1;
      return countHubWrites(file, sinceMs, untilMs);
    },
  });

  service.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.state, 'hub_writes');
  assert.equal(events[0]!.jobId, 'hub');
  assert.match(events[0]!.reason, /1 edits/);

  // Inside the gap: no second event even though the hub keeps writing.
  nowMs = T0 + 5 * 60_000;
  service.tick();
  assert.equal(events.length, 1);

  // Past the gap, and the writes are history: silent.
  nowMs = T0 + HUB_WRITES_EVENT_GAP_MS + 2 * 60_000;
  service.tick();
  assert.equal(events.length, 1);
  assert.equal(counted, 2);   // the gap tick skipped the read entirely

  // The hub writes again: corrected exactly once more.
  const file2 = fixtureDatabase(dir, [
    { agent: 'morph-hub', parent: null, parts: [
      { type: 'tool', tool: 'edit', at: nowMs - 1_000 },
      { type: 'tool', tool: 'write', at: nowMs - 500 },
    ] },
  ]);
  const service2 = createHubContractService({ now: () => new Date(nowMs), databasePath: file2 });
  service2.tick();
  assert.equal(events.filter((event) => event.state === 'hub_writes').length, 2);
  assert.match(events.at(-1)!.reason, /2 edits/);

  // appendHubEvent itself stays shape-compatible with the wake service's parser.
  assert.doesNotThrow(() => appendHubEvent({ jobId: 'hub', state: 'hub_writes', title: 't', reason: 'r' }));
});
