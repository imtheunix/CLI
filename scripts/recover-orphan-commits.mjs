#!/usr/bin/env node
/**
 * One-shot recovery for job worktrees whose commits never reached origin/main.
 *
 * Usage:
 *   scripts/recover-orphan-commits.mjs <jobs-root> [--dry-run] [--json]
 *
 * <jobs-root> is the directory that holds job worktrees, e.g.
 * ~/Tribeira/.jobs/<project>. Each immediate child that is the root of a git
 * worktree is treated as one job; its id is the directory name.
 *
 * For every job branch with commits not already on origin/main, this creates
 * recovered/<job-id> rebased onto origin/main and tags it orphan/<job-id>.
 * The original branch and worktree are only read, never moved or reset. The
 * rebase runs in a temporary worktree that is removed afterwards. Nothing is
 * pushed. Existing recovered branches or orphan tags are left untouched, so
 * reruns are idempotent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function usage() {
  return 'usage: recover-orphan-commits.mjs <jobs-root> [--dry-run] [--json]';
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function tail(text, lines = 8) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validJobId(id) {
  return JOB_ID.test(id) && id !== '.' && id !== '..' && !id.includes('..') && !id.endsWith('.lock');
}

function validRef(repo, ref) {
  return git(repo, ['check-ref-format', ref]).status === 0;
}

function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(usage());
  return { root: positional[0], dryRun, json };
}

function discoverJobs(root) {
  const jobs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // symlinks are not job worktrees
    const id = entry.name;
    const worktree = path.join(root, id);
    if (!validJobId(id)) {
      jobs.push({ id, worktree, status: 'skipped', reason: 'unsafe job id' });
      continue;
    }
    let realWorktree;
    try {
      realWorktree = realpathSync(worktree);
    } catch {
      jobs.push({ id, worktree, status: 'skipped', reason: 'unreadable worktree path' });
      continue;
    }
    if (!isInside(root, realWorktree)) {
      jobs.push({ id, worktree, status: 'skipped', reason: 'worktree resolves outside jobs root' });
      continue;
    }
    if (!existsSync(path.join(worktree, '.git'))) continue;
    const inside = git(worktree, ['rev-parse', '--is-inside-work-tree']);
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') continue;
    const top = git(worktree, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) continue;
    let realTop;
    try {
      realTop = realpathSync(top.stdout.trim());
    } catch {
      continue;
    }
    if (realTop !== realWorktree) continue; // only the worktree root, not a nested directory
    jobs.push({ id, worktree, realWorktree });
  }
  return jobs;
}

function recoverJob(job, root, dryRun) {
  const { id, worktree } = job;
  const branchResult = git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchResult.status !== 0) {
    return { ...job, status: 'skipped', reason: 'detached HEAD' };
  }
  const branch = branchResult.stdout.trim();
  if (!branch || branch.startsWith('-') || !validRef(worktree, `refs/heads/${branch}`)) {
    return { ...job, status: 'skipped', reason: 'unsafe or invalid branch name' };
  }

  const commonResult = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonResult.status !== 0) {
    return { ...job, status: 'failed', branch, reason: 'cannot locate the repository' };
  }
  const commonDir = commonResult.stdout.trim();
  const repo = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    return { ...job, status: 'failed', branch, reason: 'repository path is not a directory' };
  }

  const originMain = git(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']);
  if (originMain.status !== 0) {
    return { ...job, status: 'failed', branch, reason: 'origin/main is missing' };
  }

  const ahead = git(repo, ['rev-list', '--count', `refs/remotes/origin/main..refs/heads/${branch}`]);
  if (ahead.status !== 0) {
    return { ...job, status: 'failed', branch, reason: `cannot compare branch: ${tail(ahead.stderr)}` };
  }
  if (Number(ahead.stdout.trim()) === 0) {
    return { ...job, status: 'skipped', branch, reason: 'already on origin/main' };
  }

  const recoveryBranch = `recovered/${id}`;
  const tag = `orphan/${id}`;
  if (!validRef(repo, `refs/heads/${recoveryBranch}`) || !validRef(repo, `refs/tags/${tag}`)) {
    return { ...job, status: 'failed', branch, reason: 'recovery ref name is invalid' };
  }
  if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) {
    return { ...job, status: 'skipped', branch, reason: `already recovered (${tag} exists)` };
  }
  if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${recoveryBranch}`]).status === 0) {
    // A branch without its tag is an unknown partial recovery (for example a
    // crash between branch creation and tagging). Never move, delete or tag it.
    return {
      ...job,
      status: 'failed',
      branch,
      reason: `${recoveryBranch} exists without ${tag}; needs inspection`,
    };
  }

  const originalSha = git(repo, ['rev-parse', `refs/heads/${branch}`]).stdout.trim();
  if (dryRun) {
    return { ...job, status: 'would-recover', branch, originalSha, recoveryBranch, tag };
  }

  const tempParent = mkdtempSync(path.join(tmpdir(), 'orphan-recovery-'));
  const tempWorktree = path.join(tempParent, 'worktree');
  let branchCreated = false;
  let tagCreated = false;
  try {
    const add = git(repo, ['worktree', 'add', '-b', recoveryBranch, tempWorktree, originalSha]);
    if (add.status !== 0) throw new Error(`cannot create temporary worktree: ${tail(add.stderr)}`);
    branchCreated = true;

    const rebase = git(tempWorktree, ['rebase', 'refs/remotes/origin/main']);
    if (rebase.status !== 0) {
      git(tempWorktree, ['rebase', '--abort']);
      throw new Error(`rebase onto origin/main failed: ${tail(rebase.stderr || rebase.stdout)}`);
    }

    const tagResult = git(repo, ['tag', tag, `refs/heads/${recoveryBranch}`]);
    if (tagResult.status !== 0) throw new Error(`cannot create ${tag}: ${tail(tagResult.stderr)}`);
    tagCreated = true;

    return {
      ...job,
      status: 'recovered',
      branch,
      originalSha,
      recoveryBranch,
      tag,
      recoveredSha: git(repo, ['rev-parse', `refs/heads/${recoveryBranch}`]).stdout.trim(),
    };
  } catch (error) {
    return { ...job, status: 'failed', branch, reason: error.message };
  } finally {
    // Only temporary resources are removed. On failure the recovery branch is
    // deleted too, so a later run can retry; the original branch is untouched.
    if (branchCreated) git(repo, ['worktree', 'remove', '--force', tempWorktree]);
    if (branchCreated && !tagCreated) git(repo, ['branch', '-D', recoveryBranch]);
    rmSync(tempParent, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`recover-orphan-commits: ${error.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  let root;
  try {
    root = realpathSync(options.root);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`recover-orphan-commits: jobs root is not a readable directory: ${options.root}`);
    process.exit(2);
  }

  const results = discoverJobs(root).map((job) => {
    if (job.status) return job;
    return recoverJob(job, root, options.dryRun);
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const detail = result.reason ? ` (${result.reason})` : '';
      const refs = result.recoveryBranch ? ` -> ${result.recoveryBranch} + ${result.tag}` : '';
      console.log(`${result.status}\t${result.id}\t${result.branch ?? '-'}${refs}${detail}`);
    }
  }

  if (results.some((result) => result.status === 'failed')) process.exit(1);
}

main();
