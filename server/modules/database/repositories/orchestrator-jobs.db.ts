import { getConnection } from '@/modules/database/connection.js';

export type OrchestratorBackend = 'claude' | 'codex' | 'glm';

export type OrchestratorJobState = 'queued' | 'preparing' | 'active' | 'done' | 'cancelled' | 'failed';

// review: a finished job waits for the orchestrating session's `tjob approve` before the queue (hub-and-spoke)
export type OrchestratorMergeStep = 'none' | 'review' | 'queued' | 'rebase' | 'check' | 'push' | 'deploy' | 'merged' | 'blocked';

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

  update(id: string, patch: JobPatch): OrchestratorJobRow | null {
    const columns = PATCHABLE_COLUMNS.filter((column) => column in patch);
    if (columns.length > 0) {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      getConnection()
        .prepare(`UPDATE orchestrator_jobs SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...columns.map((column) => patch[column] ?? null), id);
    }
    return this.get(id);
  },
};
