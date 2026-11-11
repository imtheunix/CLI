import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import { appendHubEvent } from './hub-events.service.js';

/**
 * The delegation contract, made mechanical for the hub itself (the person, 2026-11-11: "it is
 * not a rule, it is a command"): the OrchestrationRoom never writes code — its own edit count
 * above zero is a defect. This service counts the hub session's edit/write tool calls in a
 * window and, when there are any, tells the hub through the same event log the wake service
 * already tails: the next wake carries the correction, exactly like a stalled job's does.
 */

/** The window the hub's own writes are counted over. */
export const HUB_WRITES_WINDOW_MS = 60 * 60_000;

/** The minimum gap between two hub_writes events: one correction an hour is enough. */
export const HUB_WRITES_EVENT_GAP_MS = 60 * 60_000;

/** Dependencies injected into createHubContractService. */
export type HubContractDependencies = {
  now?: () => Date;
  /** OpenCode's database path; defaults to the workstation's. Tests inject a fixture. */
  databasePath?: string;
  /** Reads the count; overridable for tests that never touch a database. */
  readCount?: (databasePath: string, sinceMs: number, nowMs: number) => number;
};

/** The hub's own edit/write tool calls in the window, straight from OpenCode's database (read-only, tolerant of a lock). */
export function countHubWrites(databasePath: string, sinceMs: number, nowMs: number): number {
  if (!existsSync(databasePath)) return 0;
  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  } catch {
    return 0;
  }
  try {
    const rows = database.prepare(`
      SELECT p.data FROM part p JOIN session s ON p.session_id = s.id
      WHERE s.agent = 'morph-hub' AND s.parent_id IS NULL
        AND p.time_created >= ? AND p.time_created <= ?
    `).all(sinceMs, nowMs) as Array<{ data: string }>;
    let edits = 0;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as { type?: string; tool?: string };
        if (data.type === 'tool' && (data.tool === 'edit' || data.tool === 'write')) edits += 1;
      } catch {
        // A malformed part row is not a write.
      }
    }
    return edits;
  } catch {
    return 0;
  } finally {
    database.close();
  }
}

export function createHubContractService(deps: HubContractDependencies = {}) {
  const now = deps.now ?? (() => new Date());
  const databasePath = deps.databasePath ?? getOpenCodeDatabasePath();
  const readCount = deps.readCount ?? countHubWrites;
  let lastEventAtMs = 0;

  return {
    /** One health-tick step: count the hub's own writes and correct it through the hub event log. */
    tick(): void {
      const nowMs = now().getTime();
      if (nowMs - lastEventAtMs < HUB_WRITES_EVENT_GAP_MS) return;
      const edits = readCount(databasePath, nowMs - HUB_WRITES_WINDOW_MS, nowMs);
      if (edits <= 0) return;
      lastEventAtMs = nowMs;
      appendHubEvent({
        jobId: 'hub',
        state: 'hub_writes',
        title: 'TheHub - OrchestrationRoom',
        reason: `made ${edits} edits itself in the last 60m — the delegation contract is a command: dispatch the work to DeepSeek jobs, never write it yourself`,
      });
    },
  };
}

export type HubContractService = ReturnType<typeof createHubContractService>;
