import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UTILITY = fileURLToPath(new URL('../recover-orphan-commits.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'orphan-recovery-test-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const jobs = path.join(root, 'jobs');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  mkdirSync(jobs);
  return { root, remote, repo, jobs };
}

function addJob(fixture, id, branch) {
  const worktree = path.join(fixture.jobs, id);
  git(fixture.repo, 'worktree', 'add', '-b', branch, worktree, 'origin/main');
  return worktree;
}

function advanceMain(fixture, file, content, message) {
  writeFileSync(path.join(fixture.repo, file), content);
  git(fixture.repo, 'add', file);
  git(fixture.repo, 'commit', '-m', message);
  git(fixture.repo, 'push', 'origin', 'main');
}

function runUtility(fixture, ...args) {
  const result = spawnSync(process.execPath, [UTILITY, fixture.jobs, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    results: result.stdout.trim() ? JSON.parse(result.stdout) : [],
  };
}

function byId(results, id) {
  return results.find((result) => result.id === id);
}

function remoteRefs(fixture) {
  return git(fixture.repo, 'ls-remote', fixture.remote);
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

test('recovers unique commits onto origin/main, skips up-to-date jobs, and never pushes', () => {
  const fixture = setup();
  try {
    const jobA = addJob(fixture, 'job-a', 'feature/job-a');
    writeFileSync(path.join(jobA, 'a.txt'), 'job a\n');
    git(jobA, 'add', 'a.txt');
    git(jobA, 'commit', '-m', 'job a work');
    const originalSha = git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a');
    const originalHead = git(jobA, 'rev-parse', 'HEAD');
    writeFileSync(path.join(jobA, 'uncommitted.txt'), 'keep me\n');

    advanceMain(fixture, 'main.txt', 'main moved\n', 'advance main');
    const jobB = addJob(fixture, 'job-b', 'feature/job-b');
    const upToDateSha = git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-b');
    const beforeRemote = remoteRefs(fixture);

    const run = runUtility(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(byId(run.results, 'job-a').status, 'recovered');
    assert.equal(byId(run.results, 'job-b').status, 'skipped');
    assert.match(byId(run.results, 'job-b').reason, /already on origin\/main/);

    const originMain = git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main');
    const recoveredSha = git(fixture.repo, 'rev-parse', 'refs/heads/recovered/job-a');
    const tagSha = git(fixture.repo, 'rev-parse', 'refs/tags/orphan/job-a');
    assert.equal(tagSha, recoveredSha, 'the orphan tag marks the recovered branch tip');
    assert.equal(git(fixture.repo, 'rev-parse', `${recoveredSha}^`), originMain, 'recovered branch is based on current origin/main');
    assert.equal(git(fixture.repo, 'show', 'recovered/job-a:a.txt'), 'job a');
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a'), originalSha, 'original branch is unchanged');
    assert.equal(git(jobA, 'rev-parse', 'HEAD'), originalHead, 'original worktree HEAD is unchanged');
    assert.equal(readFileSync(path.join(jobA, 'uncommitted.txt'), 'utf8'), 'keep me\n', 'uncommitted changes survive');
    assert.match(git(jobA, 'status', '--porcelain'), /uncommitted\.txt/);

    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-b'), upToDateSha);
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/heads/recovered/job-b'));
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/tags/orphan/job-b'));
    assert.equal(remoteRefs(fixture), beforeRemote, 'nothing was pushed');
    assert.doesNotMatch(remoteRefs(fixture), /recovered|orphan/);
  } finally {
    cleanup(fixture);
  }
});

test('a conflicting recovery is non-destructive and reported', () => {
  const fixture = setup();
  try {
    const jobC = addJob(fixture, 'job-c', 'feature/job-c');
    writeFileSync(path.join(jobC, 'shared.txt'), 'job c\n');
    git(jobC, 'add', 'shared.txt');
    git(jobC, 'commit', '-m', 'job c changes shared file');
    const originalSha = git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-c');
    const originalHead = git(jobC, 'rev-parse', 'HEAD');
    writeFileSync(path.join(jobC, 'uncommitted.txt'), 'keep me\n');

    advanceMain(fixture, 'shared.txt', 'main\n', 'main changes shared file');
    const beforeRemote = remoteRefs(fixture);

    const run = runUtility(fixture);
    assert.equal(run.status, 1, 'a failed recovery is reported with a non-zero exit');
    const result = byId(run.results, 'job-c');
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /rebase onto origin\/main failed/);

    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-c'), originalSha, 'original branch is unchanged');
    assert.equal(git(jobC, 'rev-parse', 'HEAD'), originalHead, 'original worktree HEAD is unchanged');
    assert.equal(readFileSync(path.join(jobC, 'shared.txt'), 'utf8'), 'job c\n', 'original worktree files are unchanged');
    assert.equal(readFileSync(path.join(jobC, 'uncommitted.txt'), 'utf8'), 'keep me\n', 'uncommitted changes survive');
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/heads/recovered/job-c'));
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/tags/orphan/job-c'));
    assert.equal(remoteRefs(fixture), beforeRemote, 'nothing was pushed');
  } finally {
    cleanup(fixture);
  }
});

test('reruns do not overwrite existing recovered refs', () => {
  const fixture = setup();
  try {
    const jobA = addJob(fixture, 'job-a', 'feature/job-a');
    writeFileSync(path.join(jobA, 'a.txt'), 'job a\n');
    git(jobA, 'add', 'a.txt');
    git(jobA, 'commit', '-m', 'job a work');
    const originalSha = git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a');
    advanceMain(fixture, 'main.txt', 'main moved\n', 'advance main');

    const first = runUtility(fixture);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(byId(first.results, 'job-a').status, 'recovered');
    const recoveredSha = git(fixture.repo, 'rev-parse', 'refs/heads/recovered/job-a');
    const tagSha = git(fixture.repo, 'rev-parse', 'refs/tags/orphan/job-a');

    const second = runUtility(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(byId(second.results, 'job-a').status, 'skipped');
    assert.match(byId(second.results, 'job-a').reason, /already recovered/);
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/recovered/job-a'), recoveredSha, 'recovered branch is not overwritten');
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/tags/orphan/job-a'), tagSha, 'orphan tag is not overwritten');
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a'), originalSha, 'original branch is unchanged');
  } finally {
    cleanup(fixture);
  }
});

test('a recovered branch without its orphan tag is reported for inspection and left untouched', () => {
  const fixture = setup();
  try {
    const jobA = addJob(fixture, 'job-a', 'feature/job-a');
    writeFileSync(path.join(jobA, 'a.txt'), 'job a\n');
    git(jobA, 'add', 'a.txt');
    git(jobA, 'commit', '-m', 'job a work');
    const originalSha = git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a');
    advanceMain(fixture, 'main.txt', 'main moved\n', 'advance main');

    // Simulate a crash after creating the recovery branch but before tagging.
    git(fixture.repo, 'branch', 'recovered/job-a', originalSha);
    const unknownSha = git(fixture.repo, 'rev-parse', 'refs/heads/recovered/job-a');

    const run = runUtility(fixture);
    assert.equal(run.status, 1, 'an unknown partial recovery is reported as a failure');
    const result = byId(run.results, 'job-a');
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /exists without orphan\/job-a; needs inspection/);

    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/recovered/job-a'), unknownSha, 'unknown branch is unchanged');
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/tags/orphan/job-a'));
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/heads/feature/job-a'), originalSha, 'original branch is unchanged');
  } finally {
    cleanup(fixture);
  }
});

test('dry-run reports work without creating refs', () => {
  const fixture = setup();
  try {
    const jobA = addJob(fixture, 'job-a', 'feature/job-a');
    writeFileSync(path.join(jobA, 'a.txt'), 'job a\n');
    git(jobA, 'add', 'a.txt');
    git(jobA, 'commit', '-m', 'job a work');
    advanceMain(fixture, 'main.txt', 'main moved\n', 'advance main');

    const run = runUtility(fixture, '--dry-run');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(byId(run.results, 'job-a').status, 'would-recover');
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/heads/recovered/job-a'));
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', 'refs/tags/orphan/job-a'));
  } finally {
    cleanup(fixture);
  }
});
