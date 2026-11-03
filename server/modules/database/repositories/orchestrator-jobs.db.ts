import { getConnection } from '@/modules/database/connection.js';

/** Orchestrator services/routes use these persisted backend ids for scheduling and job views. */
export type OrchestratorBackend = 'claude' | 'codex' | 'glm' | 'agy' | 'zcode';

export type OrchestratorJobState = 'queued' | 'preparing' | 'active' | 'done' | 'cancelled' | 'failed';

// review: a finished job waits for the orchestrating session's `tjob approve` before the queue (hub-and-spoke)
export type OrchestratorMergeStep = 'none' | 'review' | 'queued' | 'rebase' | 'check' | 'push' | 'deploy' | 'merged' | 'blocked';

/** One entry of a job's CI/CD queue history: a step (or `check:run`, its check starting) and when it began. */
export type OrchestratorMergeStepEvent = { step: OrchestratorMergeStep | 'check:run'; at: string };

export type OrchestratorJobRow = {
  id: string;
  title: string;
  prompt: string;
  repo_path: string;
  base_branch: string;
  requested_backend: OrchestratorBackend | null;
  backend: OrchestratorBackend | null;
  /** The model the job asked for (`tjob new --model`), then the one it runs on once started. */
  model: string | null;
  branch: string;
  worktree_path: string;
  session_id: string | null;
  state: OrchestratorJobState;
  in_turn: number;
  merge_step: OrchestratorMergeStep;
  merge_attempts: number;
  pushed_sha: string | null;
  deploy_waiting_since: string | null;
  /** JSON array of OrchestratorMergeStepEvent; read it with `readMergeStepHistory`. */
  merge_step_history: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type JobPatch = Partial<Pick<OrchestratorJobRow,
  'backend' | 'model' | 'session_id' | 'state' | 'in_turn' | 'merge_step' | 'merge_attempts'
  | 'pushed_sha' | 'deploy_waiting_since' | 'last_error'>>;

const PATCHABLE_COLUMNS: Array<keyof JobPatch> = [
  'backend', 'model', 'session_id', 'state', 'in_turn', 'merge_step', 'merge_attempts',
  'pushed_sha', 'deploy_waiting_since', 'last_error',
];

/** Used by the Orchestrator's views: a job's CI/CD queue history, oldest first. */
export function readMergeStepHistory(job: Pick<OrchestratorJobRow, 'merge_step_history'>): OrchestratorMergeStepEvent[] {
  try {
    const parsed = JSON.parse(job.merge_step_history ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed as OrchestratorMergeStepEvent[] : [];
  } catch {
    return [];
  }
}

/** Used by the Orchestrator module to persist jobs, so balancing and the CI/CD queue survive restarts. */
export const orchestratorJobsDb = {
  create(input: {
    id: string;
    title: string;
    prompt: string;
    repoPath: string;
    baseBranch: string;
    requestedBackend: OrchestratorBackend | null;
    model?: string | null;
    branch: string;
    worktreePath: string;
  }): OrchestratorJobRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO orchestrator_jobs (id, title, prompt, repo_path, base_branch, requested_backend, model, branch, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.title,
      input.prompt,
      input.repoPath,
      input.baseBranch,
      input.requestedBackend,
      input.model ?? null,
      input.branch,
      input.worktreePath,
    );
    return this.get(input.id) as OrchestratorJobRow;
  },

  get(id: string): OrchestratorJobRow | null {
    return (getConnection().prepare('SELECT * FROM orchestrator_jobs WHERE id = ?').get(id) as OrchestratorJobRow | undefined) ?? null;
  },

  getBySessionId(sessionId: string): OrchestratorJobRow | null {
    return (getConnection()
      .prepare('SELECT * FROM orchestrator_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as OrchestratorJobRow | undefined) ?? null;
  },

  /** Oldest first, which is also the order queued jobs are given a backend in. */
  list(): OrchestratorJobRow[] {
    return getConnection()
      .prepare('SELECT * FROM orchestrator_jobs ORDER BY created_at ASC, rowid ASC')
      .all() as OrchestratorJobRow[];
  },

  listByState(states: OrchestratorJobState[]): OrchestratorJobRow[] {
    const placeholders = states.map(() => '?').join(', ');
    return getConnection()
      .prepare(`SELECT * FROM orchestrator_jobs WHERE state IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`)
      .all(...states) as OrchestratorJobRow[];
  },

  listInMergeQueue(): OrchestratorJobRow[] {
    return getConnection()
      .prepare(`SELECT * FROM orchestrator_jobs
                WHERE merge_step NOT IN ('none', 'review', 'merged', 'blocked')
                ORDER BY updated_at ASC, rowid ASC`)
      .all() as OrchestratorJobRow[];
  },

  /** A new merge step is also recorded in the job's step history, with when it began. */
  update(id: string, patch: JobPatch): OrchestratorJobRow | null {
    if (patch.merge_step) {
      const current = this.get(id);
      if (current && current.merge_step !== patch.merge_step) this.recordMergeStep(id, patch.merge_step);
    }
    const columns = PATCHABLE_COLUMNS.filter((column) => column in patch);
    if (columns.length > 0) {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      getConnection()
        .prepare(`UPDATE orchestrator_jobs SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...columns.map((column) => patch[column] ?? null), id);
    }
    return this.get(id);
  },

  /** Appends to the step history without changing the step (`check:run`: the check got its slot). */
  recordMergeStep(id: string, step: OrchestratorMergeStepEvent['step'], at = new Date().toISOString()): void {
    const current = this.get(id);
    if (!current) return;
    const history = [...readMergeStepHistory(current), { step, at }];
    getConnection().prepare('UPDATE orchestrator_jobs SET merge_step_history = ? WHERE id = ?').run(JSON.stringify(history), id);
  },
};
