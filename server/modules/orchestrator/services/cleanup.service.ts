import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { pruneJobCheckpoints, runGitCommand } from '@/modules/worktrees/index.js';

import type { OrchestratorConfig } from './orchestrator-config.service.js';
import { runCommand } from './workspace.service.js';

/** Jobs service uses this to clean a finished job, or report what a sweep would do. */
export async function cleanupJob(job: OrchestratorJobRow, config: OrchestratorConfig, dryRun: boolean): Promise<{ id: string; status: string }> {
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
  if (existsSync(job.worktree_path)) {
    const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: job.worktree_path });
    if (status.code !== 0 || status.stdout.trim()) return result('dirty or inaccessible worktree; kept');
    if (!dryRun) {
      const removed = await runCommand('git', ['worktree', 'remove', '--force', job.worktree_path], { cwd: job.repo_path });
      if (removed.code !== 0) return result(`worktree removal failed: ${removed.stderr.trim()}`);
    }
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
  return result(dryRun ? 'would clean' : 'cleaned');
}
