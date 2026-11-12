import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';

import type { HubService } from '../services/hub.service.js';
import type { MorphUsage, MorphUsageService } from '../services/morph-usage.service.js';
import { loadOrchestratorConfig } from '../services/orchestrator-config.service.js';
import { createStatusService, formatStatusMarkdown, parseGoals } from '../services/status.service.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const sqliteAgo = (ms: number): string => ago(ms).slice(0, 19).replace('T', ' ');
const HOUR = 3_600_000;
const MINUTE = 60_000;

function job(overrides: Partial<OrchestratorJobRow> & Pick<OrchestratorJobRow, 'id' | 'title'>): OrchestratorJobRow {
  return {
    prompt: '',
    repo_path: '/repo',
    base_branch: 'main',
    requested_backend: null,
    backend: 'morph',
    model: 'morph/morph-dsv41flash',
    branch: `feature/${overrides.id}`,
    worktree_path: `/work/${overrides.id}`,
    session_id: null,
    state: 'active',
    in_turn: 0,
    merge_step: 'none',
    merge_attempts: 0,
    pushed_sha: null,
    deploy_waiting_since: null,
    merge_step_history: null,
    review_step: 'none',
    review_verdict: null,
    review_risk: null,
    review_tier: null,
    review_round: 0,
    review_head_sha: null,
    review_session_id: null,
    last_error: null,
    failure_class: null,
    resume_at: null,
    limit_recovery: null,
    backend_history: null,
    title_history: null,
    cancel_no_push: 0,
    created_at: sqliteAgo(2 * HOUR),
    updated_at: sqliteAgo(MINUTE),
    ...overrides,
  };
}

const GOALS = `# Goals (kept by the Kimi hub)

## Goal A  | status: running | updated: 2026-11-10
now: doing A / next: do B / jobs: j1 j2 / needs the person: the restart

## Goal B  | status: blocked | updated: 2026-11-10
now: waiting / next: none / jobs: none / needs the person: none

# Done (last 7 days)
- 2026-11-10 something merged
`;

const MORPH_USAGE: MorphUsage = {
  source: 'ledger',
  at: NOW.toISOString(),
  groups: {
    kimi: { group: 'kimi', uncachedIn: 100, out: 10, caps: { uncachedIn: 72_870, out: 6_162 }, minutes: [] },
    deepseek: { group: 'deepseek', uncachedIn: 200, out: 20, caps: { uncachedIn: 2_103_237, out: 76_559 }, minutes: [] },
  },
};

const HUB = {
  sessionId: 'hub-1',
  wake: true,
  provider: 'opencode',
  model: 'morph/morph-kimik31',
  effort: 'medium',
  agent: 'morph-hub',
  customName: 'Hub',
  exists: true,
};

function message(id: string, msAgo: number, data: Record<string, unknown>): string {
  return JSON.stringify({ id, session_id: 's', time_created: NOW.getTime() - msAgo, data: JSON.stringify(data) });
}

async function withFixtures(run: (input: {
  goalsPath: string;
  databasePath: string;
  ledgerPath: string;
  hubEventsLogPath: string;
  statusFilePath: string;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'status-service-'));
  try {
    const goalsPath = path.join(root, 'goals.md');
    const databasePath = path.join(root, 'opencode.db');
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const hubEventsLogPath = path.join(root, 'hub-events.log');
    const statusFilePath = path.join(root, 'STATUS.md');
    await writeFile(goalsPath, GOALS);
    await writeFile(ledgerPath, [
      JSON.stringify({ ts: ago(10 * MINUTE), wait_ms: 1_000, retries: 1, status: 200 }),
      JSON.stringify({ ts: ago(2 * HOUR), wait_ms: 2_000, retries: 2, status: 429 }),
    ].join('\n'));
    await writeFile(hubEventsLogPath, `${ago(5 * MINUTE)}\tjob-1\treview\tTitle\twaiting for review\n`);

    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, time_updated INTEGER NOT NULL);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      `);
      database.prepare('INSERT INTO session (id, parent_id, directory, title, agent, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s', null, '/home/busu/Tribeira', 'Hub session', 'morph-hub', NOW.getTime());
      const insert = database.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
      const add = (id: string, msAgo: number, data: Record<string, unknown>) => {
        const row = JSON.parse(message(id, msAgo, data)) as { time_created: number; data: string };
        insert.run(id, 's', row.time_created, row.time_created, row.data);
      };
      const morph = (agent: string, modelID: string, tokens: Record<string, unknown>) => ({
        role: 'assistant', providerID: 'morph', modelID, agent, tokens,
      });
      add('ds1', 10 * MINUTE, morph('build', 'morph-dsv41flash', { input: 100, output: 1_000, reasoning: 0, cache: { read: 0 } }));
      add('ds2', 20 * MINUTE, morph('build', 'morph-dsv41flash', { input: 100, output: 2_000, reasoning: 0, cache: { read: 0 } }));
      add('ds3', 2 * HOUR, morph('build', 'morph-dsv41flash', { input: 100, output: 5_000, reasoning: 0, cache: { read: 0 } }));
      add('k1', 10 * MINUTE, morph('morph-hub', 'morph-kimik31', { input: 1_000, output: 100, reasoning: 50, cache: { read: 3_000 } }));
      add('k2', 20 * MINUTE, morph('morph-planner', 'morph-kimik31', { input: 500, output: 200, reasoning: 100, cache: { read: 1_000 } }));
      add('k3', 30 * MINUTE, morph('build', 'morph-kimik31', { input: 200, output: 50, reasoning: 0, cache: { read: 0 } }));
      add('k4', 40 * MINUTE, morph('compaction', 'morph-kimik31', { input: 400, output: 60, reasoning: 40, cache: { read: 0 } }));
      add('k5', 2 * HOUR, morph('morph-hub', 'morph-kimik31', { input: 2_000, output: 200, reasoning: 100, cache: { read: 0 } }));
    } finally {
      database.close();
    }

    await run({ goalsPath, databasePath, ledgerPath, hubEventsLogPath, statusFilePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A hub, a contract job (delegates, few edits) and a pre-contract job (many edits, no delegation). */
async function withDelegationFixtures(run: (input: {
  goalsPath: string;
  databasePath: string;
  ledgerPath: string;
  hubEventsLogPath: string;
  statusFilePath: string;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'status-delegation-'));
  try {
    const goalsPath = path.join(root, 'goals.md');
    const databasePath = path.join(root, 'opencode.db');
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const hubEventsLogPath = path.join(root, 'hub-events.log');
    const statusFilePath = path.join(root, 'STATUS.md');
    await writeFile(goalsPath, '');
    await writeFile(ledgerPath, '');
    await writeFile(hubEventsLogPath, '');

    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, agent TEXT, time_updated INTEGER NOT NULL);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      `);
      const insertSession = database.prepare('INSERT INTO session (id, parent_id, directory, title, agent, time_updated) VALUES (?, ?, ?, ?, ?, ?)');
      const insertMessage = database.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
      const insertPart = database.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
      const now = NOW.getTime();
      const addSession = (id: string, parentId: string | null, directory: string, title: string, agent: string, msAgo: number) => {
        insertSession.run(id, parentId, directory, title, agent, now - msAgo);
      };
      const addAssistant = (id: string, sessionId: string, msAgo: number, output: number) => {
        const ts = now - msAgo;
        insertMessage.run(id, sessionId, ts, ts, JSON.stringify({
          role: 'assistant', providerID: 'morph', modelID: 'morph-kimik31', agent: 'build',
          tokens: { input: 10, output, reasoning: 0, cache: { read: 0 } },
        }));
      };
      const addUser = (id: string, sessionId: string, msAgo: number, text: string) => {
        const ts = now - msAgo;
        insertMessage.run(id, sessionId, ts, ts, JSON.stringify({ role: 'user' }));
        insertPart.run(`${id}-p`, id, sessionId, ts, ts, JSON.stringify({ type: 'text', text }));
      };
      const addTool = (id: string, sessionId: string, msAgo: number, tool: string, input: Record<string, unknown> = {}) => {
        const ts = now - msAgo;
        insertPart.run(id, `msg-${id}`, sessionId, ts, ts, JSON.stringify({ type: 'tool', tool, state: { status: 'completed', input } }));
      };

      addSession('hub-sess', null, '/home/busu/Tribeira', 'Hub session', 'morph-hub', 5 * MINUTE);
      addUser('hub-user', 'hub-sess', 2 * HOUR, 'You are the hub.');
      addAssistant('hub-a1', 'hub-sess', 10 * MINUTE, 100);
      addTool('hub-t1', 'hub-sess', 9 * MINUTE, 'task', { subagent_type: 'explore' });
      addTool('hub-t2', 'hub-sess', 8 * MINUTE, 'read');
      addTool('hub-t3', 'hub-sess', 7 * MINUTE, 'bash');

      addSession('job-contract', null, '/home/busu/Tribeira/.jobs/tribeiracli/contract-1', 'Contract job', 'build', 3 * MINUTE);
      addUser('contract-user', 'job-contract', 3 * HOUR, 'You are Morph.\nFor this model (morph-kimik31):\n- delegate');
      addAssistant('contract-a1', 'job-contract', 5 * MINUTE, 200);
      addTool('contract-t1', 'job-contract', 4 * MINUTE, 'task', { subagent_type: 'morph-scout' });
      addTool('contract-t2', 'job-contract', 4 * MINUTE, 'task', { subagent_type: 'morph-scout' });
      addTool('contract-t3', 'job-contract', 3 * MINUTE, 'task', { subagent_type: 'explore' });
      addTool('contract-t4', 'job-contract', 2 * MINUTE, 'edit');
      addTool('contract-t5', 'job-contract', 2 * MINUTE, 'read');
      addTool('contract-t6', 'job-contract', 1 * MINUTE, 'read');
      addTool('contract-t7', 'job-contract', 1 * MINUTE, 'bash');

      addSession('job-pre', null, '/home/busu/Tribeira/.jobs/tribeiracli/pre-1', 'Pre-contract job', 'build', 2 * MINUTE);
      addUser('pre-user', 'job-pre', 4 * HOUR, 'You are Morph.');
      addAssistant('pre-a1', 'job-pre', 6 * MINUTE, 300);
      for (let index = 0; index < 5; index += 1) addTool(`pre-edit-${index}`, 'job-pre', 5 * MINUTE, 'edit');
      for (let index = 0; index < 2; index += 1) addTool(`pre-write-${index}`, 'job-pre', 5 * MINUTE, 'write');
      for (let index = 0; index < 3; index += 1) addTool(`pre-read-${index}`, 'job-pre', 4 * MINUTE, 'read');
      for (let index = 0; index < 2; index += 1) addTool(`pre-bash-${index}`, 'job-pre', 3 * MINUTE, 'bash');

      // A subagent's child session is not a row of its own.
      addSession('child-sess', 'job-contract', '/home/busu/Tribeira/.jobs/tribeiracli/contract-1', 'Child', 'morph-scout', 1 * MINUTE);
      addAssistant('child-a1', 'child-sess', 1 * MINUTE, 50);
      addTool('child-t1', 'child-sess', 1 * MINUTE, 'task', { subagent_type: 'explore' });
    } finally {
      database.close();
    }

    await run({ goalsPath, databasePath, ledgerPath, hubEventsLogPath, statusFilePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parseGoals reads title, status, updated, now, next, jobs and needs; Done is not a goal', () => {
  const goals = parseGoals(GOALS);
  assert.equal(goals.length, 2);
  assert.deepEqual(goals[0], {
    title: 'Goal A',
    status: 'running',
    updated: '2026-11-10',
    now: 'doing A',
    next: 'do B',
    jobs: ['j1', 'j2'],
    needs: 'the restart',
  });
  assert.equal(goals[1].needs, null);
});

test('status JSON from fixtures: needsYou, 24 h filtering, capacity, hub and efficiency math', async () => {
  await withFixtures(async ({ goalsPath, databasePath, ledgerPath, hubEventsLogPath, statusFilePath }) => {
    const rows: OrchestratorJobRow[] = [
      job({ id: 'j1', title: 'Running job', state: 'active', created_at: sqliteAgo(2 * HOUR) }),
      job({ id: 'j2', title: 'At review', state: 'done', merge_step: 'review', backend: 'glm', review_tier: 'deep', updated_at: sqliteAgo(10 * MINUTE) }),
      job({ id: 'j3', title: 'In queue', state: 'done', merge_step: 'check', backend: 'glm', updated_at: sqliteAgo(5 * MINUTE) }),
      job({
        id: 'j4', title: 'Merged job', state: 'done', merge_step: 'merged', session_id: 'sess-merged', review_tier: 'refute',
        created_at: sqliteAgo(3 * HOUR), updated_at: sqliteAgo(HOUR), merge_attempts: 1,
        merge_step_history: JSON.stringify([
          { step: 'review', at: ago(2 * HOUR) },
          { step: 'queued', at: ago(110 * MINUTE) },
          { step: 'merged', at: ago(HOUR) },
        ]),
      }),
      job({
        id: 'j5', title: 'Old merge', state: 'done', merge_step: 'merged',
        created_at: sqliteAgo(30 * HOUR), updated_at: sqliteAgo(25 * HOUR),
        merge_step_history: JSON.stringify([{ step: 'review', at: ago(26 * HOUR) }, { step: 'merged', at: ago(25 * HOUR) }]),
      }),
      job({ id: 'j6', title: 'Failed job', state: 'failed', backend: 'claude', updated_at: sqliteAgo(HOUR), last_error: 'boom' }),
      job({ id: 'j7', title: 'Old failure', state: 'failed', backend: 'claude', updated_at: sqliteAgo(30 * HOUR), last_error: 'old' }),
      job({ id: 'j8', title: 'Blocked job', state: 'done', merge_step: 'blocked', backend: 'codex', updated_at: sqliteAgo(2 * HOUR), last_error: 'check failed' }),
      job({ id: 'j9', title: 'Cancelled job', state: 'cancelled', backend: 'glm', updated_at: sqliteAgo(HOUR) }),
    ];

    const config = loadOrchestratorConfig('/nonexistent/orchestrator.json');
    config.morph.caps.deepseek.out = 10_000;
    config.backends.morph.cap = 2;

    const service = createStatusService({
      config: () => config,
      jobs: {
        list: () => rows,
        loads: () => ({ claude: 0, codex: 0, glm: 0, agy: 0, zcode: 0, morph: 1 }) as Record<OrchestratorBackend, number>,
        backendStatus: () => ({ glm: null, zcode: null }),
      },
      morphUsage: { usage: () => MORPH_USAGE, admitted: () => true } as MorphUsageService,
      hub: { status: () => HUB } as unknown as HubService,
      now: () => NOW,
      goalsPath,
      databasePath,
      ledgerPath,
      hubEventsLogPath,
      statusFilePath,
      getJobTokens: (sessionId) => (sessionId === 'sess-merged' ? 5_000 : null),
    });

    const status = service.snapshot();

    assert.deepEqual(status.needsYou.goals, ['the restart']);
    // Needs-you is not time-bounded: an old failure still asks for a decision.
    assert.deepEqual(status.needsYou.jobs.map((entry) => entry.id).sort(), ['j6', 'j7', 'j8']);

    assert.deepEqual(status.jobs.running.map((entry) => entry.id), ['j1']);
    assert.equal(status.jobs.running[0].ageMs, 2 * HOUR);
    assert.deepEqual(status.jobs.review.map((entry) => entry.id), ['j2']);
    assert.equal(status.jobs.review[0].waitingMs, 10 * MINUTE);
    assert.equal(status.jobs.review[0].tier, 'deep');
    assert.deepEqual(status.jobs.queue.map((entry) => entry.id), ['j3']);
    assert.equal(status.jobs.queue[0].step, 'check');
    // j5 merged 25 h ago is outside the 24 h window.
    assert.deepEqual(status.jobs.merged.map((entry) => entry.id), ['j4']);
    // j7 failed 30 h ago is outside the 24 h window.
    assert.deepEqual(status.jobs.failed.map((entry) => entry.id).sort(), ['j6', 'j8']);

    assert.equal(status.capacity.loads.morph, 1);
    assert.equal(status.capacity.caps.morph, 2);
    assert.equal(status.hub.lastWakeAt, ago(5 * MINUTE));

    const hour = status.efficiency.hour;
    assert.equal(hour.deepseek.activeMinutes, 2);
    assert.ok(Math.abs(hour.deepseek.capUseAvg - 0.15) < 1e-9);
    assert.ok(Math.abs(hour.deepseek.capUseP90 - 0.2) < 1e-9);
    assert.ok(Math.abs(hour.deepseek.slotOccupancy - 0.5) < 1e-9);
    assert.deepEqual(hour.kimi.outputByRole, { hub: 150, planner: 300, jobs: 50, compaction: 100 });
    assert.ok(Math.abs(hour.kimi.reasoningShare - 190 / 600) < 1e-9);
    assert.ok(Math.abs(hour.kimi.cacheHit - 4_000 / 6_100) < 1e-9);
    assert.equal(hour.kimi.uncachedInputPerHubCall, 1_000);
    assert.equal(hour.flow.leadTimeMedianMs, 2 * HOUR);
    assert.equal(hour.flow.reviewWaitMedianMs, 10 * MINUTE);
    assert.equal(hour.flow.reviewWaitMaxMs, 10 * MINUTE);
    assert.equal(hour.flow.fixRoundRate, 1);
    assert.deepEqual(hour.flow.reviewTiers, { gate: 0, refute: 1, deep: 0 });
    assert.equal(hour.flow.mergedPerHour, 1);
    assert.equal(hour.flow.tokensPerMergedJob, 5_000);
    assert.equal(hour.waste.compactionTokens, 500);
    assert.equal(hour.waste.cancelledJobs, 1);
    assert.equal(hour.waste.pacerWaitMs, 1_000);
    assert.equal(hour.waste.retries429, 1);

    const day = status.efficiency.day;
    assert.equal(day.deepseek.activeMinutes, 3);
    assert.ok(Math.abs(day.deepseek.capUseP90 - 0.5) < 1e-9);
    assert.ok(Math.abs(day.deepseek.slotOccupancy - 3 / 48) < 1e-9);
    assert.deepEqual(day.kimi.outputByRole, { hub: 450, planner: 300, jobs: 50, compaction: 100 });
    assert.ok(Math.abs(day.kimi.reasoningShare - 290 / 900) < 1e-9);
    assert.ok(Math.abs(day.kimi.cacheHit - 4_000 / 8_100) < 1e-9);
    assert.equal(day.kimi.uncachedInputPerHubCall, 1_500);
    assert.equal(day.waste.pacerWaitMs, 3_000);
    assert.equal(day.waste.retries429, 3);

    const markdown = formatStatusMarkdown(status);
    assert.match(markdown, /## Needs you/);
    assert.match(markdown, /the restart/);
    assert.match(markdown, /## Goals/);
    assert.match(markdown, /## Jobs now/);
    assert.match(markdown, /## Capacity/);
    assert.match(markdown, /## Hub/);
    assert.match(markdown, /## Efficiency \(1h\)/);
    assert.match(markdown, /## Efficiency \(24h\)/);

    const written = service.writeMarkdown();
    assert.equal(written, statusFilePath);
  });
});

test('delegation metrics: one row per Kimi session, counts, marker and ratio', async () => {
  await withDelegationFixtures(async ({ goalsPath, databasePath, ledgerPath, hubEventsLogPath, statusFilePath }) => {
    const config = loadOrchestratorConfig('/nonexistent/orchestrator.json');
    const service = createStatusService({
      config: () => config,
      jobs: {
        list: () => [],
        loads: () => ({ claude: 0, codex: 0, glm: 0, agy: 0, zcode: 0, morph: 0 }) as Record<OrchestratorBackend, number>,
        backendStatus: () => ({ glm: null, zcode: null }),
      },
      morphUsage: { usage: () => MORPH_USAGE, admitted: () => true } as MorphUsageService,
      hub: { status: () => HUB } as unknown as HubService,
      now: () => NOW,
      goalsPath,
      databasePath,
      ledgerPath,
      hubEventsLogPath,
      statusFilePath,
    });

    const day = service.snapshot().efficiency.day.delegation;
    assert.deepEqual(day.sessions.map((session) => session.label), ['hub', 'contract-1 Contract job', 'pre-1 Pre-contract job']);

    const hub = day.sessions[0];
    assert.equal(hub.kind, 'hub');
    assert.deepEqual(hub.subagents, { explore: 1 });
    assert.equal(hub.subagentCalls, 1);
    assert.equal(hub.edits, 0);
    assert.equal(hub.reads, 1);
    assert.equal(hub.bash, 1);
    assert.equal(hub.outputTokens, 100);
    assert.equal(hub.guidance, false);

    const contract = day.sessions[1];
    assert.equal(contract.kind, 'job');
    assert.deepEqual(contract.subagents, { 'morph-scout': 2, explore: 1 });
    assert.equal(contract.subagentCalls, 3);
    assert.equal(contract.edits, 1);
    assert.equal(contract.reads, 2);
    assert.equal(contract.bash, 1);
    assert.equal(contract.outputTokens, 200);
    assert.equal(contract.guidance, true);

    const pre = day.sessions[2];
    assert.deepEqual(pre.subagents, {});
    assert.equal(pre.subagentCalls, 0);
    assert.equal(pre.edits, 7);
    assert.equal(pre.reads, 3);
    assert.equal(pre.bash, 2);
    assert.equal(pre.outputTokens, 300);
    assert.equal(pre.guidance, false);

    assert.deepEqual(day.hub, { subagentCalls: 1, edits: 0, ratio: 1 });
    assert.deepEqual(day.jobs, { subagentCalls: 3, edits: 8, ratio: 3 / 11 });

    const markdown = formatStatusMarkdown(service.snapshot());
    assert.match(markdown, /delegation: hub 1\/1 \(100\.0%\) \| jobs 3\/11 \(27\.3%\)/);
    assert.match(markdown, /contract-1 Contract job  subagents explore:1 morph-scout:2 \| edits 1 \| reads 2 \| bash 1 \| out 200 \| guidance yes/);
    assert.match(markdown, /pre-1 Pre-contract job  subagents none \| edits 7 \| reads 3 \| bash 2 \| out 300 \| guidance no/);
  });
});

test('the snapshot is cached for 30 s', async () => {
  await withFixtures(async ({ goalsPath, databasePath, ledgerPath, hubEventsLogPath, statusFilePath }) => {
    let calls = 0;
    let clock = NOW.getTime();
    const config = loadOrchestratorConfig('/nonexistent/orchestrator.json');
    const service = createStatusService({
      config: () => config,
      jobs: {
        list: () => {
          calls += 1;
          return [];
        },
        loads: () => ({ claude: 0, codex: 0, glm: 0, agy: 0, zcode: 0, morph: 0 }) as Record<OrchestratorBackend, number>,
        backendStatus: () => ({ glm: null, zcode: null }),
      },
      morphUsage: { usage: () => MORPH_USAGE, admitted: () => true } as MorphUsageService,
      hub: { status: () => HUB } as unknown as HubService,
      now: () => new Date(clock),
      goalsPath,
      databasePath,
      ledgerPath,
      hubEventsLogPath,
      statusFilePath,
    });
    service.snapshot();
    service.snapshot();
    assert.equal(calls, 1);
    clock += 30_000;
    service.snapshot();
    assert.equal(calls, 2);
  });
});
