import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

// Snapshot/restore approach reimplemented from T3 Code's CheckpointStore and GitVcsDriver
// (github.com/t3dotgg/t3-code, MIT): each snapshot is a `git write-tree` through a
// temporary index (GIT_INDEX_FILE) committed with `git commit-tree` onto a dedicated ref,
// so HEAD, the real index and the stash (shared across worktrees) are never touched.
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import type {
  JobCheckpointCaptureInput,
  JobCheckpointCaptureResult,
  JobCheckpointPruneInput,
  JobCheckpointPruneResult,
  JobCheckpointRollbackInput,
  JobCheckpointRollbackResult,
  GitCommandResult,
  GitEnvCommandRunner,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import { findWorktreeEntryByPath, listWorktreePorcelainEntries } from '@/modules/worktrees/services/worktree-git.service.js';

/** Ref namespace for job checkpoints: one ref per captured turn, `…/<jobId>/<turn>`. */
const CHECKPOINT_REFS_PREFIX = 'refs/tribeira/checkpoints';

/**
 * Index configuration for the temporary checkpoint index. A scratch index must
 * never engage the fsmonitor hook, and a split-index write through it could
 * expire shared-index files the real index still uses.
 */
const SCRATCH_INDEX_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.splitIndex=false',
  '-c', 'splitIndex.sharedIndexExpire=never',
] as const;

/** Fixed identity for checkpoint commits: they are internal refs, never merged or pushed. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Tribeira CLI',
  GIT_AUTHOR_EMAIL: 'checkpoints@tribeira.local',
  GIT_COMMITTER_NAME: 'Tribeira CLI',
  GIT_COMMITTER_EMAIL: 'checkpoints@tribeira.local',
} as const;

/**
 * Job ids are UUID fragments, but every value that reaches a ref name is
 * validated anyway: a crafted id could otherwise point `update-ref` anywhere.
 */
function validateJobId(jobId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    throw new AppError(`Invalid job id: ${jobId}`, { code: 'INVALID_JOB_ID', statusCode: 400 });
  }
  return jobId;
}

function checkpointRef(jobId: string, turn: number): string {
  return `${CHECKPOINT_REFS_PREFIX}/${validateJobId(jobId)}/${turn}`;
}

/** The checkpoint refs that exist for one job, as their turn numbers, ascending. */
async function listCheckpointTurns(jobId: string, cwd: string, runGit: GitEnvCommandRunner): Promise<number[]> {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REFS_PREFIX}/${validateJobId(jobId)}/`],
    cwd,
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line.slice(line.lastIndexOf('/') + 1)))
    .filter((turn) => Number.isInteger(turn) && turn >= 1)
    .sort((a, b) => a - b);
}

/** The commit a checkpoint ref points at, or null when the ref does not resolve. */
async function resolveCheckpointCommit(ref: string, cwd: string, runGit: GitEnvCommandRunner): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** HEAD's commit hash, or null in a repository without commits. */
async function resolveHeadCommit(cwd: string, runGit: GitEnvCommandRunner): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** Windows path comparisons are case-insensitive, mirroring findWorktreeEntryByPath. */
function samePath(left: string, right: string): boolean {
  const a = normalizeProjectPath(left);
  const b = normalizeProjectPath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Captures one job checkpoint (called by the Orchestrator's turn-complete hook
 * in `handleRunCompleted`): everything tracked plus every non-ignored file as
 * they are on disk — uncommitted changes included — becomes a tree via a
 * temporary index (`GIT_INDEX_FILE` inside the git common dir), is committed
 * with `git commit-tree` (HEAD as parent, so checkpoints chain), and the
 * commit lands on `refs/tribeira/checkpoints/<jobId>/<turn>`. HEAD, the real
 * index and the stash are never written; the temporary index file is removed
 * afterwards.
 *
 * Resolves null when there is nothing to snapshot (the worktree folder is
 * gone, e.g. a cancelled job whose cleanup already ran). Throws on git
 * failures; the hook is a best-effort caller that logs and moves on.
 */
export async function captureJobCheckpoint(
  input: JobCheckpointCaptureInput,
  dependencies: { runGit: GitEnvCommandRunner },
): Promise<JobCheckpointCaptureResult | null> {
  const { runGit } = dependencies;
  const jobId = validateJobId(input.jobId);
  const worktreePath = input.worktreePath;
  if (!existsSync(worktreePath)) return null;

  const { stdout: commonDir } = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    worktreePath,
  );
  const headSha = await resolveHeadCommit(worktreePath, runGit);
  const existingTurns = await listCheckpointTurns(jobId, worktreePath, runGit);
  const turn = (existingTurns.at(-1) ?? 0) + 1;
  const ref = checkpointRef(jobId, turn);

  // The scratch index lives in the common dir: same filesystem as the real
  // index, and relative index paths keep working.
  const tempIndexPath = path.join(commonDir.trim(), `tribeira-checkpoint-${randomUUID()}`);
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexPath, ...CHECKPOINT_IDENTITY };
  try {
    if (headSha) {
      await runGit([...SCRATCH_INDEX_CONFIG, 'read-tree', '--reset', 'HEAD'], worktreePath, indexEnv);
    }
    await runGit([...SCRATCH_INDEX_CONFIG, 'add', '-A'], worktreePath, indexEnv);
    const { stdout: treeSha } = await runGit([...SCRATCH_INDEX_CONFIG, 'write-tree'], worktreePath, indexEnv);
    const trimmedTree = treeSha.trim();
    if (!trimmedTree) {
      throw new AppError('git write-tree returned an empty tree', {
        code: 'CHECKPOINT_CAPTURE_FAILED',
        statusCode: 500,
      });
    }
    const { stdout: commitSha } = await runGit(
      ['commit-tree', trimmedTree, ...(headSha ? ['-p', headSha] : []), '-m', `tribeira checkpoint job=${jobId} turn=${turn}`],
      worktreePath,
      CHECKPOINT_IDENTITY,
    );
    const trimmedCommit = commitSha.trim();
    if (!trimmedCommit) {
      throw new AppError('git commit-tree returned an empty commit', {
        code: 'CHECKPOINT_CAPTURE_FAILED',
        statusCode: 500,
      });
    }
    await runGit(['update-ref', ref, trimmedCommit], worktreePath);
    return { jobId, turn, ref, commitSha: trimmedCommit };
  } finally {
    // The lock file can outlive a failed git run; remove both, best-effort.
    for (const candidate of [tempIndexPath, `${tempIndexPath}.lock`]) {
      await unlink(candidate).catch(() => undefined);
    }
  }
}

/**
 * Restores a job's worktree to a captured checkpoint (called by the Orchestrator's
 * `POST /api/orchestrator/:id/rollback`, wired as `tjob rollback <id> <turn>`).
 *
 * Refusals, in order: unknown job; a job that is running or being prepared
 * (`JOB_RUNNING` — rollback would race the agent's writes); a worktree that is
 * the repository's main checkout (`WORKTREE_SHARED` — it is shared with every
 * other session); a worktree of a different repository; and an unknown turn
 * (`CHECKPOINT_NOT_FOUND`). A worktree removed by cleanup is recreated from
 * the job's retained branch first.
 *
 * Restore semantics, explicit: tracked files are restored to the checkpoint
 * content; files that appeared after the checkpoint are deleted (they are part
 * of what is being undone); untracked files recorded in the checkpoint come
 * back as untracked; ignored files (build output, dependencies) are never
 * touched. HEAD does not move — commits made after the checkpoint remain and
 * show up as unstaged differences — and the index is reset to HEAD, so the
 * worktree reads exactly like it did when the turn ended.
 */
export async function rollbackJobCheckpoint(
  input: JobCheckpointRollbackInput,
  dependencies: {
    runGit: GitEnvCommandRunner;
    /** The Orchestrator's job store; production wires `orchestratorJobsDb.get`. */
    getJob: (jobId: string) => OrchestratorJobRow | null;
    /** The Orchestrator's liveness check (preparing, in-turn, session busy). */
    isJobRunning: (job: OrchestratorJobRow) => boolean;
  },
): Promise<JobCheckpointRollbackResult> {
  const { runGit, getJob, isJobRunning } = dependencies;
  const jobId = validateJobId(input.jobId);
  if (!Number.isInteger(input.turn) || input.turn < 1) {
    throw new AppError(`Invalid checkpoint turn: ${input.turn}`, {
      code: 'INVALID_CHECKPOINT_TURN',
      statusCode: 400,
    });
  }
  const job = getJob(jobId);
  if (!job) {
    throw new AppError(`Job ${jobId} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
  }
  if (isJobRunning(job)) {
    throw new AppError(`Job ${jobId} is ${job.state === 'preparing' ? 'being prepared' : 'running'}; stop it before a rollback`, {
      code: 'JOB_RUNNING',
      statusCode: 409,
    });
  }

  const ref = checkpointRef(jobId, input.turn);
  // Checkpoints live in the common dir, so the ref resolves from the main checkout
  // even after the worktree was removed.
  const commitSha = await resolveCheckpointCommit(ref, job.repo_path, runGit);
  if (!commitSha) {
    throw new AppError(`Job ${jobId} has no checkpoint for turn ${input.turn}`, {
      code: 'CHECKPOINT_NOT_FOUND',
      statusCode: 404,
    });
  }

  let recreatedWorktree = false;
  if (!existsSync(job.worktree_path)) {
    if ((await resolveCheckpointCommit(`refs/heads/${job.branch}`, job.repo_path, runGit)) === null) {
      throw new AppError(`Branch ${job.branch} is gone; the worktree cannot be recreated`, {
        code: 'BRANCH_NOT_FOUND',
        statusCode: 404,
      });
    }
    await runGit(['worktree', 'add', job.worktree_path, job.branch], job.repo_path);
    recreatedWorktree = true;
  } else {
    const entries = await listWorktreePorcelainEntries(job.worktree_path, runGit);
    const entry = findWorktreeEntryByPath(entries, job.worktree_path);
    if (entry === entries[0]) {
      throw new AppError('Rollback refuses the repository main checkout: it is shared with every other session', {
        code: 'WORKTREE_SHARED',
        statusCode: 409,
      });
    }
    if (!samePath(entries[0].path, job.repo_path)) {
      throw new AppError(`Worktree belongs to ${entries[0].path}, not to the job's repository`, {
        code: 'WORKTREE_REPOSITORY_MISMATCH',
        statusCode: 409,
      });
    }
  }

  await restoreCheckpointTree(job.worktree_path, commitSha, runGit);
  return { jobId, turn: input.turn, ref, commitSha, recreatedWorktree };
}

/**
 * Applies a checkpoint commit's tree to a worktree: files that appeared after
 * the checkpoint are deleted, the checkpoint's files are restored into index
 * and worktree, and the index is reset to HEAD so checkpoint-only files read
 * as untracked and checkpoint edits read as unstaged changes.
 */
async function restoreCheckpointTree(
  worktreePath: string,
  commitSha: string,
  runGit: GitEnvCommandRunner,
): Promise<void> {
  const nulSeparated = (result: GitCommandResult) =>
    result.stdout.split('\0').filter((entry) => entry.length > 0);

  const snapshotFiles = new Set(
    nulSeparated(await runGit(['ls-tree', '-r', '--name-only', '-z', commitSha], worktreePath)),
  );
  const currentFiles = [
    ...nulSeparated(await runGit(['ls-files', '-z'], worktreePath)),
    ...nulSeparated(await runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath)),
  ];

  for (const file of currentFiles) {
    if (snapshotFiles.has(file)) continue;
    // git reports repository-relative paths; refuse anything that could escape the worktree.
    if (path.isAbsolute(file) || file.split('/').includes('..')) continue;
    await unlink(path.join(worktreePath, file)).catch(() => undefined);
  }

  // An empty checkpoint (worktree was empty at capture time) has nothing for
  // restore's pathspec to match; reset below still empties the index to HEAD.
  if (snapshotFiles.size > 0) {
    await runGit(['restore', '--source', commitSha, '--worktree', '--staged', '--', '.'], worktreePath);
  }
  await runGit(['reset', '--quiet', '--', '.'], worktreePath);
}

/**
 * Deletes every checkpoint ref of a job (called by the Orchestrator's cleanup
 * sweep, when a job merges or is cleaned up): the snapshot commits are only
 * reachable through these refs, so git garbage-collects them afterwards. Runs
 * from any path inside the repository — the refs live in the common dir, so
 * the main checkout works even after the worktree is gone.
 */
export async function pruneJobCheckpoints(
  input: JobCheckpointPruneInput,
  dependencies: { runGit: GitEnvCommandRunner },
): Promise<JobCheckpointPruneResult> {
  const { runGit } = dependencies;
  const jobId = validateJobId(input.jobId);
  const prunedRefs: string[] = [];
  for (const turn of await listCheckpointTurns(jobId, input.repoPath, runGit)) {
    const ref = checkpointRef(jobId, turn);
    await runGit(['update-ref', '-d', ref], input.repoPath);
    prunedRefs.push(ref);
  }
  return { jobId, prunedRefs };
}
