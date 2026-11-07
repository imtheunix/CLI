// worktreesRoutes: used by the server entrypoint to mount the complete Worktrees HTTP API at `/api/worktrees`.
export { worktreesRoutes } from './worktrees.module.js';

// runGitCommand: the production Git runner (with optional env overrides) that the Orchestrator
// passes into the job checkpoint services below.
export { runGitCommand } from './services/worktree-git.service.js';

// captureJobCheckpoint, pruneJobCheckpoints, rollbackJobCheckpoint: used by the Orchestrator —
// captureJobCheckpoint in the turn-complete hook (`handleRunCompleted`), pruneJobCheckpoints in
// the cleanup sweep, rollbackJobCheckpoint behind `POST /api/orchestrator/:id/rollback`
// (`tjob rollback <id> <turn>`). Snapshots go through a temporary index onto dedicated refs, so
// HEAD, the real index and the stash are never touched.
export {
  captureJobCheckpoint,
  pruneJobCheckpoints,
  rollbackJobCheckpoint,
} from './services/worktree-checkpoint.service.js';
