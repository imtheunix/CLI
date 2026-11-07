import { getConnection as connection } from '@/modules/database/connection.js';
import { ORCHESTRATOR_EFFECTS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const ensured = new WeakSet<object>();

/** Databases opened without the migrations (some tests) get the table on first use. */
function getConnection(): ReturnType<typeof connection> {
  const db = connection();
  if (!ensured.has(db)) {
    db.exec(ORCHESTRATOR_EFFECTS_TABLE_SCHEMA_SQL);
    ensured.add(db);
  }
  return db;
}

/** The orchestrator's side effects recorded in its outbox (see docs/orchestrator.md, "Restart-safe action record"). */
export type OrchestratorEffectKind =
  | 'start_turn'
  | 'abort_turn'
  | 'merge_check'
  | 'push'
  | 'cleanup'
  | 'hub_wake'
  | 'recovery_resume'
  | 'checkpoint'
  | 'rollback';

/** safe: idempotent, replayed after a restart; process_bound: tied to the process that ran it, dropped after a restart. */
export type OrchestratorEffectReplay = 'safe' | 'process_bound';

export type OrchestratorEffectState = 'pending' | 'running' | 'done' | 'failed' | 'dropped';

export type OrchestratorEffectRow = {
  key: string;
  job_id: string | null;
  kind: OrchestratorEffectKind;
  replay: OrchestratorEffectReplay;
  state: OrchestratorEffectState;
  /** 1: an undo (abort, cleanup) whose failure blocks the job's later effects until it succeeds. */
  blocking: number;
  attempts: number;
  /** JSON the replay handler needs. */
  payload: string | null;
  /** The server process that last wrote the row. */
  boot_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type Patch = Partial<Pick<OrchestratorEffectRow, 'state' | 'attempts' | 'boot_id' | 'last_error' | 'payload'>>;

/** Used by the orchestrator's effect outbox: one row per side effect, written before the effect runs. */
export const orchestratorEffectsDb = {
  insert(row: Omit<OrchestratorEffectRow, 'created_at' | 'updated_at'>): OrchestratorEffectRow {
    const at = new Date().toISOString();
    getConnection().prepare(
      `INSERT INTO orchestrator_effects (key, job_id, kind, replay, state, blocking, attempts, payload, boot_id, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.key, row.job_id, row.kind, row.replay, row.state, row.blocking, row.attempts, row.payload, row.boot_id, row.last_error, at, at);
    return this.get(row.key) as OrchestratorEffectRow;
  },

  get(key: string): OrchestratorEffectRow | null {
    return (getConnection().prepare('SELECT * FROM orchestrator_effects WHERE key = ?').get(key) as OrchestratorEffectRow | undefined) ?? null;
  },

  update(key: string, patch: Patch): OrchestratorEffectRow | null {
    const fields = Object.keys(patch) as Array<keyof Patch>;
    if (fields.length > 0) {
      getConnection().prepare(
        `UPDATE orchestrator_effects SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ? WHERE key = ?`,
      ).run(...fields.map((field) => patch[field] ?? null), new Date().toISOString(), key);
    }
    return this.get(key);
  },

  listByState(states: OrchestratorEffectState[]): OrchestratorEffectRow[] {
    return getConnection().prepare(
      `SELECT * FROM orchestrator_effects WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, rowid`,
    ).all(...states) as OrchestratorEffectRow[];
  },

  /** Forgets finished rows (done, dropped) last written before `before` (ISO 8601). */
  prune(before: string): number {
    return getConnection().prepare("DELETE FROM orchestrator_effects WHERE state IN ('done', 'dropped') AND updated_at < ?").run(before).changes;
  },

  listByJob(jobId: string, kind?: OrchestratorEffectKind): OrchestratorEffectRow[] {
    return (kind
      ? getConnection().prepare('SELECT * FROM orchestrator_effects WHERE job_id = ? AND kind = ? ORDER BY created_at, rowid').all(jobId, kind)
      : getConnection().prepare('SELECT * FROM orchestrator_effects WHERE job_id = ? ORDER BY created_at, rowid').all(jobId)) as OrchestratorEffectRow[];
  },
};
