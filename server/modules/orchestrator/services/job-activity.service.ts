import fs from 'node:fs';

import { runningTurnsDb, sessionsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function fileMtimeMs(filePath: string | null | undefined): number | null {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * True when a job still being prepared has a live worker: a turn is marked in
 * flight, its session has a live chat run, or a detached turn unit is recorded
 * for it. Used by status digests and hub event lines so a preparing job with a
 * worker is not read as waiting or unknown and re-dispatched.
 */
export function isPreparingJobAlive(job: OrchestratorJobRow): boolean {
  if (job.state !== 'preparing') return false;
  if (job.in_turn === 1) return true;
  if (!job.session_id) return false;
  if (chatRunRegistry.isProcessing(job.session_id)) return true;
  return runningTurnsDb.getRunningTurnBySession(job.session_id) !== null;
}

/**
 * The last real sign of life for a job, from the same sources hub-wake uses to
 * tell a live run from a dead one: the session transcript, the detached turn
 * log, the live run's start, and the job row's own last write. Returns `nowMs`
 * when nothing is known, so an unreadable job is never called stale by accident.
 */
export function lastJobActivityMs(job: OrchestratorJobRow, nowMs: number): number {
  let last = 0;
  const session = job.session_id ? sessionsDb.getSessionById(job.session_id) : null;
  const transcript = fileMtimeMs(session?.jsonl_path);
  if (transcript !== null && transcript > last) last = transcript;

  if (job.session_id) {
    const runningTurn = runningTurnsDb.getRunningTurnBySession(job.session_id);
    const log = fileMtimeMs(runningTurn?.log_path);
    if (log !== null && log > last) last = log;
    const started = parseTimestamp(runningTurn?.started_at);
    if (started !== null && started > last) last = started;
    const run = chatRunRegistry.getRun(job.session_id);
    if (run?.startedAt && run.startedAt > last) last = run.startedAt;
  }

  const updated = parseTimestamp(job.updated_at);
  if (updated !== null && updated > last) last = updated;
  return last === 0 ? nowMs : last;
}
