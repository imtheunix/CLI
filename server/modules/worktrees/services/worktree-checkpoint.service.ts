import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
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
  WorktreePorcelainEntry,
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

/** Worktree-relative folder rollback moves untracked work into (`discardUntracked`); excluded from checkpoints. */
export const ROLLBACK_ASIDE_DIR = '.tribeira-rollback';

/** How many times a capture retries with the next turn number when another writer took its ref. */
const CAPTURE_REF_ATTEMPTS = 5;

/**
 * In-process lock per job: captures (and rollbacks) of one job run one at a
 * time, so two turn-end hooks firing close together never pick the same turn.
 * The ref update is also compare-and-swap, for writers outside this process.
 */
const jobLocks = new Map<string, Promise<unknown>>();

function withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  jobLocks.set(jobId, tail);
  void tail.then(() => {
    if (jobLocks.get(jobId) === tail) jobLocks.delete(jobId);
  });
  return next;
}

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
  const jobId = validateJobId(input.jobId);
  return withJobLock(jobId, () => captureLocked(jobId, input.worktreePath, dependencies.runGit));
}

async function captureLocked(
  jobId: string,
  worktreePath: string,
  runGit: GitEnvCommandRunner,
): Promise<JobCheckpointCaptureResult | null> {
  if (!existsSync(worktreePath)) return null;

  const { stdout: commonDir } = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    worktreePath,
  );
  await ensureAsideDirExcluded(commonDir.trim());
  const headSha = await resolveHeadCommit(worktreePath, runGit);

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
    let lastError: unknown = null;
    for (let attempt = 0; attempt < CAPTURE_REF_ATTEMPTS; attempt += 1) {
      const turn = ((await listCheckpointTurns(jobId, worktreePath, runGit)).at(-1) ?? 0) + 1;
      const ref = checkpointRef(jobId, turn);
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
      try {
        // Compare-and-swap: an empty old value means "the ref must not exist yet";
        // a writer that took this turn first makes this fail, and we take the next one.
        await runGit(['update-ref', ref, trimmedCommit, ''], worktreePath);
        return { jobId, turn, ref, commitSha: trimmedCommit };
      } catch (error) {
        lastError = error;
        if ((await resolveCheckpointCommit(ref, worktreePath, runGit)) === null) throw error;
      }
    }
    throw new AppError(`Checkpoint of job ${jobId} lost the ref race ${CAPTURE_REF_ATTEMPTS} times: ${String(lastError)}`, {
      code: 'CHECKPOINT_CAPTURE_FAILED',
      statusCode: 409,
    });
  } finally {
    // The lock file can outlive a failed git run; remove both, best-effort.
    for (const candidate of [tempIndexPath, `${tempIndexPath}.lock`]) {
      await unlink(candidate).catch(() => undefined);
    }
  }
}

/**
 * Rollback's aside folder must never be snapshotted nor counted as untracked work
 * a later rollback would move again: it is listed in the common dir's info/exclude.
 */
async function ensureAsideDirExcluded(commonDir: string): Promise<void> {
  const excludePath = path.join(commonDir, 'info', 'exclude');
  const line = `/${ROLLBACK_ASIDE_DIR}/`;
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').some((entry) => entry.trim() === line)) return;
  await mkdir(path.dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
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
 * Ownership: the worktree must be registered at the job row's `worktree_path`
 * with the job's branch checked out (`WORKTREE_NOT_OWNED` otherwise).
 *
 * Restore semantics, explicit: tracked files are restored to the checkpoint
 * content; tracked files that appeared after the checkpoint are deleted (git
 * still has them); untracked work the restore would lose refuses the rollback
 * unless `discardUntracked` moves it aside (never unlinked); untracked files
 * recorded in the checkpoint come back as untracked; ignored files (build output, dependencies) are never
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
    /** The aside folder's timestamp; tests pin it. */
    now?: () => Date;
  },
): Promise<JobCheckpointRollbackResult> {
  const jobId = validateJobId(input.jobId);
  return withJobLock(jobId, () => rollbackLocked(jobId, input, dependencies));
}

async function rollbackLocked(
  jobId: string,
  input: JobCheckpointRollbackInput,
  dependencies: Parameters<typeof rollbackJobCheckpoint>[1],
): Promise<JobCheckpointRollbackResult> {
  const { runGit, getJob, isJobRunning } = dependencies;
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
    await assertJobOwnsWorktree(job, runGit);
  }

  const moved = await restoreCheckpointTree(job.worktree_path, commitSha, runGit, {
    discardUntracked: input.discardUntracked === true,
    now: dependencies.now ?? (() => new Date()),
  });
  return { jobId, turn: input.turn, ref, commitSha, recreatedWorktree, ...moved };
}

/**
 * The worktree a rollback writes must be the job's own: a linked worktree of the
 * job's repository, registered at exactly the job row's `worktree_path`, with
 * the job's branch checked out. The main checkout, another repository, another
 * job's worktree (or any folder that is not a registered worktree) is refused.
 */
async function assertJobOwnsWorktree(job: OrchestratorJobRow, runGit: GitEnvCommandRunner): Promise<void> {
  const entries = await listWorktreePorcelainEntries(job.worktree_path, runGit);
  if (entries.length === 0 || !samePath(entries[0].path, job.repo_path)) {
    throw new AppError(`Worktree belongs to ${entries[0]?.path ?? 'no repository'}, not to the job's repository`, {
      code: 'WORKTREE_REPOSITORY_MISMATCH',
      statusCode: 409,
    });
  }
  let entry: WorktreePorcelainEntry;
  try {
    entry = findWorktreeEntryByPath(entries, job.worktree_path);
  } catch {
    throw new AppError(`${job.worktree_path} is not a registered worktree of job ${job.id}`, {
      code: 'WORKTREE_NOT_OWNED',
      statusCode: 409,
    });
  }
  if (entry === entries[0]) {
    throw new AppError('Rollback refuses the repository main checkout: it is shared with every other session', {
      code: 'WORKTREE_SHARED',
      statusCode: 409,
    });
  }
  if (entry.branch !== job.branch) {
    throw new AppError(`Worktree ${entry.path} has ${entry.branch ?? 'a detached HEAD'} checked out, not job ${job.id}'s branch ${job.branch}`, {
      code: 'WORKTREE_NOT_OWNED',
      statusCode: 409,
    });
  }
}

/** git reports repository-relative paths; anything that could escape the worktree is skipped. */
function isSafeRelativePath(file: string): boolean {
  return !path.isAbsolute(file) && !file.split('/').includes('..');
}

/**
 * Applies a checkpoint commit's tree to a worktree: tracked files absent from the
 * checkpoint are deleted (git still has them), the checkpoint's files are
 * restored into index and worktree, and the index is reset to HEAD so
 * checkpoint-only files read as untracked and checkpoint edits read as
 * unstaged changes.
 *
 * Untracked files are never unlinked. Those the restore would lose (absent from
 * the checkpoint, or with different content) refuse the rollback by default
 * (`ROLLBACK_UNTRACKED_AT_RISK`, paths listed in the message and `details`);
 * with `discardUntracked` they are moved into `.tribeira-rollback/<timestamp>/`.
 * The check runs before anything is written.
 */
async function restoreCheckpointTree(
  worktreePath: string,
  commitSha: string,
  runGit: GitEnvCommandRunner,
  options: { discardUntracked: boolean; now: () => Date },
): Promise<{ movedUntrackedTo: string | null; movedUntracked: string[] }> {
  const nulSeparated = (result: GitCommandResult) =>
    result.stdout.split('\0').filter((entry) => entry.length > 0);

  // `<mode> <type> <sha>\t<path>` per entry.
  const snapshotBlobs = new Map<string, string>();
  for (const line of nulSeparated(await runGit(['ls-tree', '-r', '-z', commitSha], worktreePath))) {
    const tab = line.indexOf('\t');
    snapshotBlobs.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]);
  }
  const trackedFiles = nulSeparated(await runGit(['ls-files', '-z'], worktreePath));
  const untrackedFiles = nulSeparated(
    await runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', `:(exclude)${ROLLBACK_ASIDE_DIR}`], worktreePath),
  ).filter(isSafeRelativePath);

  // Untracked files the restore would delete or overwrite with other content.
  const inSnapshot = untrackedFiles.filter((file) => snapshotBlobs.has(file));
  const currentBlobs = inSnapshot.length > 0
    ? (await runGit(['hash-object', '--', ...inSnapshot], worktreePath)).stdout.split('\n').map((sha) => sha.trim())
    : [];
  const atRisk = untrackedFiles.filter((file) => {
    if (!snapshotBlobs.has(file)) return true;
    return currentBlobs[inSnapshot.indexOf(file)] !== snapshotBlobs.get(file);
  });

  let movedUntrackedTo: string | null = null;
  if (atRisk.length > 0) {
    if (!options.discardUntracked) {
      const shown = atRisk.slice(0, 50).join(', ') + (atRisk.length > 50 ? `, … (${atRisk.length - 50} more)` : '');
      throw new AppError(
        `Rollback would lose ${atRisk.length} untracked file(s): ${shown}. Commit or move them, or pass --discard-untracked to move them into ${ROLLBACK_ASIDE_DIR}/<timestamp>/`,
        { code: 'ROLLBACK_UNTRACKED_AT_RISK', statusCode: 409, details: { untracked: atRisk } },
      );
    }
    movedUntrackedTo = path.posix.join(ROLLBACK_ASIDE_DIR, options.now().toISOString().replace(/[:.]/g, '-'));
    await ensureAsideDirExcluded((await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath)).stdout.trim());
    for (const file of atRisk) {
      const target = path.join(worktreePath, movedUntrackedTo, file);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(worktreePath, file), target);
    }
  }

  for (const file of trackedFiles) {
    if (snapshotBlobs.has(file) || !isSafeRelativePath(file)) continue;
    await unlink(path.join(worktreePath, file)).catch(() => undefined);
  }

  // An empty checkpoint (worktree was empty at capture time) has nothing for
  // restore's pathspec to match; reset below still empties the index to HEAD.
  if (snapshotBlobs.size > 0) {
    await runGit(['restore', '--source', commitSha, '--worktree', '--staged', '--', '.'], worktreePath);
  }
  await runGit(['reset', '--quiet', '--', '.'], worktreePath);
  return { movedUntrackedTo, movedUntracked: movedUntrackedTo ? atRisk : [] };
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
