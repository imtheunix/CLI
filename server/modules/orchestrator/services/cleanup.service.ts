import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { pruneJobCheckpoints, runGitCommand } from '@/modules/worktrees/index.js';

import type { OrchestratorConfig } from './orchestrator-config.service.js';
import { pushBranchIfDiverged, runCommand } from './workspace.service.js';

/** Untracked files a job's agent may leave as live state (a TSGE arena ledger was lost to a cleanup on 2026-11-07). */
const LIVE_STATE_EXTENSIONS = ['.sqlite', '.sqlite-wal', '.db', '.jsonl'] as const;

/**
 * Gitignored build and dependency directories: whatever is inside them is reproducible output even when it
 * carries a live-state extension, so it is never parked with the job's state.
 */
const IGNORED_BUILD_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  '.next', '.nuxt', '.output', '.vite', '.turbo', '.parcel-cache', '.angular', '.svelte-kit', '.cache',
]);

/** Finished jobs' untracked live state is parked under this root, one folder per job id. */
const JOB_STATE_ROOT = path.join(os.homedir(), '.local', 'state', 'tribeira-jobs');

/** git reports repository-relative paths; anything that could escape the worktree is skipped. */
function isSafeRelativePath(file: string): boolean {
  return file.length > 0 && !path.isAbsolute(file) && !file.split('/').includes('..');
}

/** An ignored file the cleanup must not delete: live state by extension, outside the build directories. */
function isLiveStateFile(file: string): boolean {
  if (!isSafeRelativePath(file)) return false;
  const segments = file.split('/');
  if (segments.slice(0, -1).some((segment) => IGNORED_BUILD_DIRS.has(segment))) return false;
  const name = segments.at(-1) ?? '';
  return LIVE_STATE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * The job's untracked live-state files in its worktree, as relative paths. Only ignored files can be here: a
 * worktree with plain untracked files stays "dirty" and is never removed. Throws when git cannot list them,
 * so the caller keeps the worktree instead of guessing.
 */
async function findLiveStateFiles(worktreePath: string): Promise<string[]> {
  const listed = await runCommand('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: worktreePath });
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  return listed.stdout.split('\0').filter(isLiveStateFile);
}

/** Moves live-state files into the job's state folder (relative layout kept); returns what moved. */
async function moveLiveStateFiles(worktreePath: string, files: string[], destination: string): Promise<string[]> {
  const moved: string[] = [];
  for (const file of files) {
    const source = path.join(worktreePath, file);
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(source, target);
    } catch (error) {
      // The state root can sit on another filesystem than the worktrees.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.copyFile(source, target);
      await fs.rm(source, { force: true });
    }
    moved.push(file);
  }
  return moved;
}

/** Jobs service uses this to clean a finished job, or report what a sweep would do. */
export async function cleanupJob(
  job: OrchestratorJobRow,
  config: OrchestratorConfig,
  dryRun: boolean,
  /** Tests park live state in a temporary root; production uses ~/.local/state/tribeira-jobs. */
  options: { stateRoot?: string } = {},
): Promise<{ id: string; status: string }> {
  const result = (status: string) => ({ id: job.id, status });
  if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) return result('invalid job id');
  const expected = path.resolve(config.worktreesRoot, path.basename(job.repo_path), job.id);
  if (path.resolve(job.worktree_path) !== expected) return result('unexpected worktree path');
  const template = config.cleanup.buildDirs[path.basename(job.repo_path)];
  let buildDir: string | null = null;
  if (template) {
    if (!template.includes('{id}')) return result('invalid build directory template');
    const expanded = template.replace(/^~(?=\/)/, os.homedir()).replaceAll('{id}', job.id);
    if (!path.isAbsolute(expanded) || path.basename(path.resolve(expanded)) !== job.id) return result('invalid build directory template');
    buildDir = path.resolve(expanded);
  }
  const destination = path.join(options.stateRoot ?? JOB_STATE_ROOT, job.id);
  let movedNote = '';
  if (existsSync(job.worktree_path)) {
    const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: job.worktree_path });
    if (status.code !== 0 || status.stdout.trim()) return result('dirty or inaccessible worktree; kept');
    let liveFiles: string[] | null = null;
    try {
      liveFiles = await findLiveStateFiles(job.worktree_path);
    } catch (error) {
      console.warn(`[Orchestrator] Cleanup ${job.id}: live-state scan failed`, error);
      return result('live-state scan failed; kept');
    }
    if (dryRun) {
      return result(liveFiles.length > 0
        ? `would clean; would move ${liveFiles.length} live-state file(s) to ${destination}`
        : 'would clean');
    }
    if (liveFiles.length > 0) {
      try {
        const moved = await moveLiveStateFiles(job.worktree_path, liveFiles, destination);
        movedNote = `; moved ${moved.length} live-state file(s) to ${destination}`;
        console.info(`[Orchestrator] Cleanup ${job.id}: moved ${moved.length} untracked live-state file(s) to ${destination}: ${moved.join(', ')}`);
      } catch (error) {
        // The worktree stays: a lost ledger is worse than an unremoved worktree. The next sweep retries.
        console.warn(`[Orchestrator] Cleanup ${job.id}: live-state move failed`, error);
        return result(`live-state move failed (${error instanceof Error ? error.message : String(error)}); kept`);
      }
    }
    // A commit can land after cancellation (an abort race) and before this removal: push the branch again,
    // unless the person explicitly cancelled with --no-push. A failed push keeps the worktree.
    if (job.state === 'cancelled' && !job.cancel_no_push && job.branch) {
      const pushed = await pushBranchIfDiverged(job.worktree_path, job.branch);
      if (pushed.error) return result(`branch push failed (${pushed.error}); kept`);
    }
    const removed = await runCommand('git', ['worktree', 'remove', '--force', job.worktree_path], { cwd: job.repo_path });
    if (removed.code !== 0) return result(`worktree removal failed: ${removed.stderr.trim()}`);
  }
  if (!dryRun && buildDir) await fs.rm(buildDir, { recursive: true, force: true });
  if (!dryRun) {
    // The worktree is gone and the job is finished: the per-turn checkpoint refs
    // (and with them the snapshot commits) can go. Best effort — the job stays
    // cleaned either way; a failed prune is retried by the next sweep.
    try {
      await pruneJobCheckpoints({ jobId: job.id, repoPath: job.repo_path }, { runGit: runGitCommand });
    } catch (error) {
      console.warn(`[Orchestrator] Checkpoint prune ${job.id} failed`, error);
      return result('cleaned; checkpoint prune failed');
    }
  }
  return result(dryRun ? 'would clean' : `cleaned${movedNote}`);
}
