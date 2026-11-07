import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorJobRow } from '@/modules/database/index.js';
import {
  captureJobCheckpoint,
  pruneJobCheckpoints,
  rollbackJobCheckpoint,
} from '@/modules/worktrees/services/worktree-checkpoint.service.js';
import { runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';
import { AppError } from '@/shared/utils.js';

/** One temp repository with a main checkout and a job worktree, like the orchestrator lays them out. */
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-checkpoints-'));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'jobs', 'repo', 'jobface');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  mkdirSync(path.dirname(worktree), { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  writeFileSync(path.join(repo, 'b.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  // A real stash entry in the shared stash, so captures can prove they leave it alone.
  writeFileSync(path.join(repo, 'a.txt'), 'stashed change\n');
  git(repo, 'stash', 'push', '-m', 'kept stash');
  git(repo, 'worktree', 'add', '-b', 'feature/job-jobface', worktree);

  const job = {
    id: 'jobface',
    repo_path: repo,
    worktree_path: worktree,
    branch: 'feature/job-jobface',
    state: 'active',
    in_turn: 0,
    session_id: 'session-1',
  } as OrchestratorJobRow;
  const dependencies = {
    runGit: runGitCommand,
    getJob: (jobId: string) => (jobId === job.id ? job : null),
    isJobRunning: (candidate: OrchestratorJobRow) => candidate.in_turn === 1 || candidate.state === 'preparing',
  };
  return {
    root,
    repo,
    worktree,
    git,
    job,
    dependencies,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** sha256 over every file (relative path + bytes), so "restored exactly" is one comparison. */
function hashTree(root: string, skip: string[] = []): string {
  const hash = createHash('sha256');
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || (!rel && skip.includes(entry.name))) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
        continue;
      }
      hash.update(`${childRel}\0${readFileSync(path.join(dir, entry.name))}\0`);
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

function absoluteGitPath(worktree: string, gitPath: string): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', gitPath], { cwd: worktree })
    .toString()
    .trim();
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Bytes of HEAD, the real index and the stash ref, so a capture can prove it touched none of them. */
function protectedState(worktree: string): { headFile: string; indexFile: string; stashRef: string; stashList: string } {
  const stashPath = absoluteGitPath(worktree, 'refs/stash');
  return {
    headFile: readFileSync(absoluteGitPath(worktree, 'HEAD'), 'utf8'),
    indexFile: fileHash(absoluteGitPath(worktree, 'index')),
    stashRef: existsSync(stashPath) ? fileHash(stashPath) : 'absent',
    stashList: execFileSync('git', ['stash', 'list'], { cwd: worktree }).toString(),
  };
}

function checkpointRefs(cwd: string, jobId: string): string[] {
  return execFileSync('git', ['for-each-ref', '--format=%(refname)', `refs/tribeira/checkpoints/${jobId}/`], { cwd })
    .toString().trim().split('\n').filter((line) => line.length > 0);
}

function sortedStatus(worktree: string): string[] {
  return gitStatus(worktree).split('\n').filter((line) => line.trim()).sort();
}

function gitStatus(worktree: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: worktree }).toString();
}

test('capture snapshots the worktree through a temporary index and leaves HEAD, the real index and the stash byte-identical', async () => {
  const context = setup();
  try {
    const { git, job, worktree, dependencies } = context;
    // The agent's end-of-turn state: an unstaged edit, a staged edit and an untracked file.
    writeFileSync(path.join(worktree, 'a.txt'), 'v2\n');
    writeFileSync(path.join(worktree, 'b.txt'), 'edited\n');
    git(worktree, 'add', 'b.txt');
    writeFileSync(path.join(worktree, 'notes.md'), 'scratch\n');

    const before = protectedState(worktree);
    const headSha = git(worktree, 'rev-parse', 'HEAD').trim();

    const captured = await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    assert.ok(captured);
    assert.equal(captured.turn, 1);
    assert.equal(captured.ref, `refs/tribeira/checkpoints/${job.id}/1`);
    assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), headSha, 'HEAD must not move');
    assert.deepEqual(protectedState(worktree), before, 'HEAD, index and stash must stay byte-identical');
    assert.equal(git(worktree, 'rev-parse', '--verify', '--quiet', captured.ref).trim(), captured.commitSha);
    assert.equal(git(worktree, 'rev-parse', `${captured.commitSha}^`).trim(), headSha, 'checkpoint chains from HEAD');
    assert.match(git(worktree, 'cat-file', '-p', captured.commitSha), /Tribeira CLI/);
    // The snapshot holds the on-disk truth: staged and unstaged edits plus the untracked file.
    assert.equal(git(worktree, 'show', `${captured.commitSha}:a.txt`), 'v2\n');
    assert.equal(git(worktree, 'show', `${captured.commitSha}:b.txt`), 'edited\n');
    assert.equal(git(worktree, 'show', `${captured.commitSha}:notes.md`), 'scratch\n');
    // The scratch index is cleaned up.
    const commonDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    assert.equal(readdirSync(commonDir).filter((name) => name.startsWith('tribeira-checkpoint-')).length, 0);

    // The next ended turn gets the next number.
    writeFileSync(path.join(worktree, 'a.txt'), 'v3\n');
    const second = await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    assert.ok(second);
    assert.equal(second.turn, 2);
    assert.equal(git(worktree, 'show', `${second.commitSha}:a.txt`), 'v3\n');
  } finally {
    context.cleanup();
  }
});

test('capture skips a missing worktree', async () => {
  const context = setup();
  try {
    const { job, dependencies } = context;
    const captured = await captureJobCheckpoint(
      { jobId: job.id, worktreePath: path.join(context.root, 'jobs', 'repo', 'gone') },
      dependencies,
    );
    assert.equal(captured, null);
  } finally {
    context.cleanup();
  }
});

test('rollback restores the worktree files exactly and keeps HEAD, untracked semantics and later commits intact', async () => {
  const context = setup();
  try {
    const { git, job, worktree, dependencies } = context;
    // Turn 1 leaves: a.txt edited (unstaged), u1.txt untracked.
    writeFileSync(path.join(worktree, 'a.txt'), 'turn-1 edit\n');
    writeFileSync(path.join(worktree, 'u1.txt'), 'untracked at turn 1\n');
    const snapshotTree = hashTree(worktree);
    const captured = await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    assert.ok(captured);

    // Turn 2: commits a.txt and adds c.txt, deletes b.txt, edits the untracked file, adds u2.txt.
    writeFileSync(path.join(worktree, 'a.txt'), 'turn-2 commit\n');
    writeFileSync(path.join(worktree, 'c.txt'), 'committed after the checkpoint\n');
    git(worktree, 'add', 'a.txt', 'c.txt');
    git(worktree, 'commit', '-m', 'turn 2 work');
    rmSync(path.join(worktree, 'b.txt'));
    writeFileSync(path.join(worktree, 'u1.txt'), 'changed later\n');
    writeFileSync(path.join(worktree, 'u2.txt'), 'born after the checkpoint\n');
    const headAfterTurn2 = git(worktree, 'rev-parse', 'HEAD').trim();

    // Untracked work the restore would lose (u1.txt changed, u2.txt new) refuses the
    // rollback by default, lists the paths and writes nothing.
    const beforeRefusal = hashTree(worktree);
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'ROLLBACK_UNTRACKED_AT_RISK' && error.statusCode === 409 &&
        JSON.stringify((error.details as { untracked: string[] }).untracked) === JSON.stringify(['u1.txt', 'u2.txt']) &&
        error.message.includes('u2.txt') && error.message.includes('--discard-untracked'),
    );
    assert.equal(hashTree(worktree), beforeRefusal, 'a refused rollback changes nothing');

    // With discardUntracked they are moved aside, never unlinked.
    const rolled = await rollbackJobCheckpoint(
      { jobId: job.id, turn: 1, discardUntracked: true },
      { ...dependencies, now: () => new Date('2026-11-07T12:00:00.000Z') },
    );
    assert.equal(rolled.commitSha, captured.commitSha);
    assert.equal(rolled.recreatedWorktree, false);
    assert.equal(rolled.movedUntrackedTo, '.tribeira-rollback/2026-11-07T12-00-00-000Z');
    assert.deepEqual(rolled.movedUntracked, ['u1.txt', 'u2.txt']);
    const aside = path.join(worktree, rolled.movedUntrackedTo);
    assert.equal(readFileSync(path.join(aside, 'u1.txt'), 'utf8'), 'changed later\n');
    assert.equal(readFileSync(path.join(aside, 'u2.txt'), 'utf8'), 'born after the checkpoint\n');

    // The files are exactly as the first turn left them (the aside folder apart)…
    assert.equal(hashTree(worktree, ['.tribeira-rollback']), snapshotTree);
    // …and HEAD never moved, so the later commit survives.
    assert.equal(git(worktree, 'rev-parse', 'HEAD').trim(), headAfterTurn2);
    // The status reads like it did at capture time (' M a.txt', '?? u1.txt'), plus
    // c.txt: it is in HEAD now, so matching the snapshot can only show as a
    // deletion. b.txt is back (checkpoint content); the aside folder is excluded.
    assert.deepEqual(sortedStatus(worktree), [' D c.txt', ' M a.txt', '?? u1.txt']);
  } finally {
    context.cleanup();
  }
});

test('rollback leaves untracked files that match the checkpoint in place and needs no flag', async () => {
  const context = setup();
  try {
    const { job, worktree, dependencies } = context;
    writeFileSync(path.join(worktree, 'keep.txt'), 'same as the checkpoint\n');
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    writeFileSync(path.join(worktree, 'a.txt'), 'tracked edit after the checkpoint\n');
    const rolled = await rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, dependencies);
    assert.equal(rolled.movedUntrackedTo, null);
    assert.equal(readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'same as the checkpoint\n');
    assert.equal(readFileSync(path.join(worktree, 'a.txt'), 'utf8'), 'v1\n');
  } finally {
    context.cleanup();
  }
});

test('rollback refuses a linked worktree of the same repository that is not the job\'s (Terra repro 2)', async () => {
  const context = setup();
  try {
    const { git, job, repo, root, dependencies } = context;
    await captureJobCheckpoint({ jobId: job.id, worktreePath: job.worktree_path }, dependencies);
    const other = path.join(root, 'other');
    git(repo, 'worktree', 'add', '-b', 'other', other);
    writeFileSync(path.join(other, 'a.txt'), 'other work\n');
    // The row points at another job's worktree (its branch is not the job's).
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, {
        ...dependencies,
        getJob: (id) => (id === job.id ? { ...job, worktree_path: other } : null),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'WORKTREE_NOT_OWNED' && error.statusCode === 409,
    );
    assert.equal(readFileSync(path.join(other, 'a.txt'), 'utf8'), 'other work\n');
    // A folder inside the job's worktree is not the registered worktree path either.
    const nested = path.join(job.worktree_path, 'nested');
    mkdirSync(nested);
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, {
        ...dependencies,
        getJob: (id) => (id === job.id ? { ...job, worktree_path: nested } : null),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'WORKTREE_NOT_OWNED',
    );
    // The job's worktree with another branch checked out is refused too.
    git(job.worktree_path, 'checkout', '-q', '-b', 'switched');
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'WORKTREE_NOT_OWNED',
    );
  } finally {
    context.cleanup();
  }
});

test('overlapping captures of one job get distinct turns and both refs survive (Terra repro 3)', async () => {
  const context = setup();
  try {
    const { job, repo, worktree, dependencies } = context;
    const results = await Promise.all([1, 2, 3].map(() => captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies)));
    assert.deepEqual(results.map((result) => result?.turn), [1, 2, 3]);
    assert.equal(checkpointRefs(repo, job.id).length, 3);
  } finally {
    context.cleanup();
  }
});

test('a capture whose turn ref was taken by another writer retries with the next turn (compare-and-swap)', async () => {
  const context = setup();
  try {
    const { git, job, repo, worktree, dependencies } = context;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    let raced = false;
    // Another process creates turn 1 between this capture's listing and its ref update.
    const runGit: typeof runGitCommand = async (args, cwd, env) => {
      if (!raced && args[0] === 'update-ref' && args[1] === `refs/tribeira/checkpoints/${job.id}/1`) {
        raced = true;
        git(repo, 'update-ref', args[1], head);
      }
      return runGitCommand(args, cwd, env);
    };
    const captured = await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, { runGit });
    assert.equal(captured?.turn, 2);
    assert.equal(git(repo, 'rev-parse', `refs/tribeira/checkpoints/${job.id}/1`).trim(), head, 'the other writer\'s ref is kept');
    assert.equal(checkpointRefs(repo, job.id).length, 2);
  } finally {
    context.cleanup();
  }
});

test('rollback refuses a running job and leaves the worktree untouched', async () => {
  const context = setup();
  try {
    const { job, worktree, dependencies } = context;
    writeFileSync(path.join(worktree, 'a.txt'), 'progress\n');
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    const before = hashTree(worktree);

    const running: OrchestratorJobRow[] = [{ ...job, in_turn: 1 }, { ...job, state: 'preparing' }];
    for (const candidate of running) {
      await assert.rejects(
        rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, {
          ...dependencies,
          getJob: (id) => (id === job.id ? candidate : null),
        }),
        (error: unknown) => error instanceof AppError && error.code === 'JOB_RUNNING' && error.statusCode === 409,
      );
    }
    assert.equal(hashTree(worktree), before, 'a refused rollback changes nothing');
  } finally {
    context.cleanup();
  }
});

test('rollback refuses the repository main checkout and a worktree of another repository', async () => {
  const context = setup();
  try {
    const { git, job, repo, worktree, dependencies, root } = context;
    // A job row pointed at the main checkout: rollback would clobber the shared checkout.
    writeFileSync(path.join(worktree, 'a.txt'), 'progress\n');
    const captured = await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    assert.ok(captured);
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, {
        ...dependencies,
        getJob: (id) => (id === job.id ? { ...job, worktree_path: repo } : null),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'WORKTREE_SHARED' && error.statusCode === 409,
    );

    // A stale row whose repo is a different repository: that repository holds a
    // checkpoint ref for the same job id (its own capture), so the refusal comes
    // from the worktree ownership check, not from a missing checkpoint.
    const other = path.join(root, 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'init');
    git(other, 'config', 'user.email', 'test@example.test');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(path.join(other, 'file'), 'other repo\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'other initial');
    await captureJobCheckpoint({ jobId: job.id, worktreePath: other }, dependencies);
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, {
        ...dependencies,
        getJob: (id) => (id === job.id ? { ...job, repo_path: other } : null),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'WORKTREE_REPOSITORY_MISMATCH' && error.statusCode === 409,
    );
  } finally {
    context.cleanup();
  }
});

test('rollback recreates a worktree removed by cleanup', async () => {
  const context = setup();
  try {
    const { git, job, repo, worktree, dependencies } = context;
    writeFileSync(path.join(worktree, 'a.txt'), 'keep this state\n');
    writeFileSync(path.join(worktree, 'u1.txt'), 'untracked\n');
    const snapshotTree = hashTree(worktree);
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    git(repo, 'worktree', 'remove', '--force', worktree);
    assert.ok(!existsSync(worktree));

    const rolled = await rollbackJobCheckpoint({ jobId: job.id, turn: 1 }, dependencies);
    assert.equal(rolled.recreatedWorktree, true);
    assert.ok(existsSync(worktree));
    assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), job.branch);
    assert.equal(hashTree(worktree), snapshotTree);
  } finally {
    context.cleanup();
  }
});

test('rollback refuses unknown jobs and unknown turns', async () => {
  const context = setup();
  try {
    const { job, worktree, dependencies } = context;
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: 'ghost', turn: 1 }, dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'JOB_NOT_FOUND' && error.statusCode === 404,
    );
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 9 }, dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'CHECKPOINT_NOT_FOUND' && error.statusCode === 404,
    );
    await assert.rejects(
      rollbackJobCheckpoint({ jobId: job.id, turn: 0 }, dependencies),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_CHECKPOINT_TURN' && error.statusCode === 400,
    );
  } finally {
    context.cleanup();
  }
});

test('prune deletes every checkpoint ref and a second prune is a no-op', async () => {
  const context = setup();
  try {
    const { git, job, repo, worktree, dependencies } = context;
    writeFileSync(path.join(worktree, 'a.txt'), 'one\n');
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    writeFileSync(path.join(worktree, 'a.txt'), 'two\n');
    await captureJobCheckpoint({ jobId: job.id, worktreePath: worktree }, dependencies);
    assert.equal(checkpointRefs(repo, job.id).length, 2);

    const pruned = await pruneJobCheckpoints({ jobId: job.id, repoPath: repo }, dependencies);
    assert.deepEqual(pruned.prunedRefs, [
      'refs/tribeira/checkpoints/jobface/1',
      'refs/tribeira/checkpoints/jobface/2',
    ]);
    assert.equal(checkpointRefs(repo, job.id).length, 0);

    const again = await pruneJobCheckpoints({ jobId: job.id, repoPath: repo }, dependencies);
    assert.deepEqual(again.prunedRefs, []);
  } finally {
    context.cleanup();
  }
});
