import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

/** What a finished command left behind. `code` is 0 on success. */
export type CommandResult = { code: number; stdout: string; stderr: string };

/**
 * Used by the jobs and CI/CD queue services for every git, check and resolver
 * command. Never throws for a failing command; the caller reads `code`.
 * Arguments are passed as an array, never through a shell, except `shell`
 * commands, which are the repository check commands from the config.
 */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; shell?: boolean; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const file = options.shell ? '/bin/bash' : command;
    const argv = options.shell ? ['-lc', command] : args;
    execFile(file, argv, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + (error && code === 1 && !stderr ? error.message : '') });
    });
  });
}

/** The server's own settings, which would point a check at the live server (its database, its Claude binary). */
const SERVER_ONLY_VARIABLES = [
  'NODE_ENV', 'DATABASE_PATH', 'HOST', 'SERVER_PORT', 'PORT',
  'CLAUDE_CLI_PATH', 'CLAUDE_CODE_EXECUTABLE', 'CLAUDE_CODE_EXECPATH',
];

/**
 * Used by the CI/CD queue to run a repository's checks as a plain shell
 * would: without the server's own settings (a test must not open the live
 * server's database) or its secrets. Removed variables are set to undefined,
 * which `runCommand`'s merge over `process.env` drops.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const removed: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(env)) {
    if (SERVER_ONLY_VARIABLES.includes(name) || /SECRET|PASSWORD|API_KEY|_TOKEN$/i.test(name)) removed[name] = undefined;
  }
  return removed;
}

/** Used by the CI/CD queue to put a failure's tail in front of the agent without flooding the session. */
export function tail(text: string, lines = 60): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
  return runCommand('git', args, { cwd });
}

/**
 * Used by the jobs service when a job is created: the branch the job merges
 * into. The config wins; then origin's default branch; then `main`.
 */
export async function resolveBaseBranch(repoPath: string, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const head = await git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.code === 0 && head.stdout.trim().startsWith('origin/')) {
    return head.stdout.trim().slice('origin/'.length);
  }
  return 'main';
}

/**
 * Used by the jobs service to give a job its own worktree, branched from the
 * latest origin/<base>. Idempotent: a worktree that is already there (a
 * restart in the middle of preparing) is kept as it is.
 */
export async function prepareWorktree(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  if (!existsSync(path.join(input.worktreePath, '.git'))) {
    const fetch = await git(input.repoPath, 'fetch', '--quiet', 'origin', input.baseBranch);
    if (fetch.code !== 0) throw new Error(`git fetch origin ${input.baseBranch} failed: ${tail(fetch.stderr, 10)}`);
    await fs.mkdir(path.dirname(input.worktreePath), { recursive: true });
    const branchExists = (await git(input.repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`)).code === 0;
    const add = branchExists
      ? await git(input.repoPath, 'worktree', 'add', input.worktreePath, input.branch)
      : await git(input.repoPath, 'worktree', 'add', '-b', input.branch, input.worktreePath, `origin/${input.baseBranch}`);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${tail(add.stderr, 10)}`);
  }
  await linkNodeModules(input.repoPath, input.worktreePath);
}

/**
 * A JavaScript project needs its dependencies before an agent can run checks.
 * The main checkout's are reused (a symlink) while the lockfiles match;
 * otherwise they are installed with `npm ci`.
 */
async function linkNodeModules(repoPath: string, worktreePath: string): Promise<void> {
  const lockfile = 'package-lock.json';
  const target = path.join(worktreePath, 'node_modules');
  if (!existsSync(path.join(worktreePath, 'package.json')) || existsSync(target)) return;

  const source = path.join(repoPath, 'node_modules');
  const [ours, theirs] = await Promise.all([
    fs.readFile(path.join(worktreePath, lockfile), 'utf8').catch(() => null),
    fs.readFile(path.join(repoPath, lockfile), 'utf8').catch(() => null),
  ]);
  if (existsSync(source) && ours !== null && ours === theirs) {
    await fs.symlink(source, target, 'dir');
    await excludeFromGit(worktreePath, '/node_modules');
    return;
  }
  const install = await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: worktreePath, timeoutMs: 15 * 60_000 });
  if (install.code !== 0) throw new Error(`npm ci failed: ${tail(install.stderr, 20)}`);
}

/**
 * A `node_modules/` ignore rule does not match a symlink, so the linked
 * dependencies would leave every job's worktree dirty (and `tjob done`
 * refused). The repository's own `info/exclude` keeps them out of `git status`.
 */
async function excludeFromGit(worktreePath: string, pattern: string): Promise<void> {
  const commonDir = await git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (commonDir.code !== 0) return;
  const exclude = path.join(commonDir.stdout.trim(), 'info', 'exclude');
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').includes(pattern)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

/**
 * Used by the jobs service when a session's message goes to the load
 * balancer: the main checkout behind a folder, also when that folder is
 * itself a worktree (a job's). Null when it is not in a git repository.
 */
export async function resolveMainCheckout(folder: string): Promise<string | null> {
  const result = await git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return result.code === 0 ? path.dirname(result.stdout.trim()) : null;
}

/**
 * Used by the jobs service when a job names its repository (`tjob new
 * --repo`, a picked one from the load balancer): whether a folder is inside
 * a git repository at all, so an unusable path is refused with a clear
 * message instead of a failing `git fetch` later.
 */
export async function isGitRepository(folder: string): Promise<boolean> {
  return (await git(folder, 'rev-parse', '--git-dir')).code === 0;
}

/**
 * Used by the jobs service's repository picker: the git repositories directly
 * under a folder (the workspace), sorted by name. Hidden folders (`.jobs`)
 * and non-repositories are skipped; a `.git` file counts as much as a `.git`
 * folder, so a worktree is listed like a checkout.
 */
export async function listGitRepositories(root: string): Promise<Array<{ name: string; path: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(path.join(root, entry.name, '.git')))
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Used by the jobs and CI/CD queue services: the commit a ref points at, or null. */
export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, 'rev-parse', '--verify', '--quiet', ref);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Used by the jobs service: whether the job's branch has commits its base does not. */
export async function hasCommitsAhead(worktreePath: string, baseBranch: string): Promise<boolean> {
  const result = await git(worktreePath, 'rev-list', '--count', `origin/${baseBranch}..HEAD`);
  return result.code === 0 && Number(result.stdout.trim()) > 0;
}

/** Used by the jobs service: whether the worktree has uncommitted changes. */
export async function isDirty(worktreePath: string): Promise<boolean> {
  const result = await git(worktreePath, 'status', '--porcelain');
  return result.code !== 0 || result.stdout.trim().length > 0;
}

/**
 * Used by the CI/CD queue to find the Forgejo repository of a checkout, from
 * an origin like `ssh://git@127.0.0.1:2222/<owner>/<repo>.git`. Null when
 * origin is not a Forgejo-style URL.
 */
export async function readOriginRepository(repoPath: string): Promise<{ owner: string; repo: string } | null> {
  const result = await git(repoPath, 'remote', 'get-url', 'origin');
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(result.stdout.trim());
  return result.code === 0 && match ? { owner: match[1], repo: match[2] } : null;
}

/** Used by the CI/CD queue: the check command for a repository, from the config or what the project offers. */
export async function resolveCheckCommand(repoPath: string, worktreePath: string, configured: Record<string, string>): Promise<string | null> {
  const name = path.basename(repoPath);
  if (configured[name]) return configured[name];
  if (existsSync(path.join(worktreePath, 'scripts/check.sh'))) return 'scripts/check.sh';
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (manifest.scripts?.check) return 'npm run check';
    if (manifest.scripts?.test) return 'npm test';
  } catch { /* not a JavaScript project */ }
  if (existsSync(path.join(worktreePath, 'pom.xml'))) return 'mvn -q clean test';
  if (existsSync(path.join(worktreePath, 'Cargo.toml'))) return 'cargo test --quiet';
  if (existsSync(path.join(worktreePath, 'scripts/hermes-env.sh'))) return 'scripts/hermes-env.sh python -m pytest -q';
  if (existsSync(path.join(worktreePath, 'pyproject.toml'))) return 'python -m pytest -q';
  return null;
}
