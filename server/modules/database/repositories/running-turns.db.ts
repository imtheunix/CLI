import { getConnection } from '@/modules/database/connection.js';

export type RunningTurnRow = {
  unit_name: string;
  job_id: string | null;
  session_id: string;
  backend: string;
  log_path: string;
  started_at: string;
  status: 'running' | 'completed';
  exit_code: number | null;
  completed_at: string | null;
};

function ensureTable(db: ReturnType<typeof getConnection>): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS running_turns (
        unit_name TEXT PRIMARY KEY,
        job_id TEXT,
        session_id TEXT NOT NULL,
        backend TEXT NOT NULL,
        log_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        completed_at TEXT
      );
    `);
  } catch {}
}

/** Used by the detached-turns module to persist in-flight turns across server restarts. */
export const runningTurnsDb = {
  recordTurn(input: {
    unitName: string;
    jobId?: string | null;
    sessionId: string;
    backend: string;
    logPath: string;
    startedAt?: string;
  }): RunningTurnRow {
    const db = getConnection();
    ensureTable(db);
    const startedAt = input.startedAt ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO running_turns (unit_name, job_id, session_id, backend, log_path, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'running')
       ON CONFLICT(unit_name) DO UPDATE SET
         job_id = excluded.job_id,
         session_id = excluded.session_id,
         backend = excluded.backend,
         log_path = excluded.log_path,
         started_at = excluded.started_at,
         status = 'running'`
    ).run(input.unitName, input.jobId ?? null, input.sessionId, input.backend, input.logPath, startedAt);
    return this.getTurn(input.unitName)!;
  },

  listRunningTurns(): RunningTurnRow[] {
    const db = getConnection();
    ensureTable(db);
    return db.prepare("SELECT * FROM running_turns WHERE status = 'running' ORDER BY started_at ASC").all() as RunningTurnRow[];
  },

  getTurn(unitName: string): RunningTurnRow | null {
    const db = getConnection();
    ensureTable(db);
    const row = db.prepare('SELECT * FROM running_turns WHERE unit_name = ?').get(unitName);
    return (row as RunningTurnRow) ?? null;
  },

  getTurnByUnitName(unitName: string): RunningTurnRow | null {
    return this.getTurn(unitName);
  },

  getRunningTurnBySession(sessionId: string): RunningTurnRow | null {
    const db = getConnection();
    ensureTable(db);
    const row = db.prepare("SELECT * FROM running_turns WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(sessionId);
    return (row as RunningTurnRow) ?? null;
  },

  completeTurn(unitName: string, exitCode: number | null, status: 'completed' = 'completed'): void {
    const db = getConnection();
    ensureTable(db);
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE running_turns SET status = ?, exit_code = ?, completed_at = ? WHERE unit_name = ?'
    ).run(status, exitCode, completedAt, unitName);
  },

  deleteTurn(unitName: string): void {
    const db = getConnection();
    ensureTable(db);
    db.prepare('DELETE FROM running_turns WHERE unit_name = ?').run(unitName);
  },
};
