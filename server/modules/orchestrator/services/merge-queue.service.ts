import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { orchestratorJobsDb, readMergeStepHistory } from '@/modules/database/index.js';
import type { OrchestratorJobRow, OrchestratorMergeStep } from '@/modules/database/index.js';

import { getEffectOutbox } from './effect-outbox.service.js';
import type { EffectOutbox, EffectReplayHandler } from './effect-outbox.service.js';
import { appendHubEvent } from './hub-events.service.js';
import type { JobsService } from './jobs.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';
import {
  checkEnvironment,
  getCheckLogPath,
  readOriginRepository,
  resolveCheckCommand,
  revParse,
  runCommand,
  tail,
} from './workspace.service.js';
import type { CommandResult } from './workspace.service.js';

/** A push rejected this many times (main kept moving) stops and asks for a person. */
const MAX_PUSH_ATTEMPTS = 5;
/** A pushed commit with no Forgejo run after this long has no CI: it is merged. */
const NO_CI_GRACE_MS = 3 * 60_000;
/** A deploy still going after this long is handed to a person. */
const DEPLOY_TIMEOUT_MS = 60 * 60_000;
/** A light gate taking longer than this is stuck. */
const CHECK_TIMEOUT_MS = 20 * 60_000;
/** Rounds of conflict resolution before a rebase is given up. */
const MAX_RESOLVE_ROUNDS = 8;

/**
 * The steps that hold a repository's lane: one job at a time goes from rebase to push. The deploy is not part of
 * it: Forgejo's deploy jobs have their own concurrency groups, so a push never waits for another job's deploy.
 */
const LANE_STEPS: OrchestratorMergeStep[] = ['rebase', 'check', 'push'];

type GitRunner = (cwd: string, ...args: string[]) => Promise<CommandResult>;
type DeployRun = { commit_sha?: string; status?: string; workflow_id?: string; id?: number };

/** Forgejo run statuses that are final. */
const FINISHED_RUN_STATUSES = new Set(['success', 'failure', 'cancelled', 'skipped']);

/**
 * Used by the Orchestrator module. Takes a finished job's branch to its base
 * branch: rebase onto the latest base (Gemini Flash resolves conflicts),
 * the project's checks, push, then (by default) the deploy Forgejo runs for it.
 *
 * Every step is recorded before it runs, and each can be run again: a server
 * restart or a push rejected because another job got there first resume from
 * the step the job is at. The check is a light gate (Forgejo CI runs the full
 * suite after the push), at most `maxConcurrentChecks` at once, under `nice`.
 */
export function createMergeQueueService(deps: {
  jobs: JobsService;
  config: () => OrchestratorConfig;
  run?: typeof runCommand;
  fetchJson?: (url: string, token: string) => Promise<unknown>;
  now?: () => number;
  /** The durable effect outbox; tests give each simulated server process its own. */
  outbox?: EffectOutbox;
}) {
  const outbox = deps.outbox ?? getEffectOutbox();
  const run = deps.run ?? runCommand;
  const now = deps.now ?? Date.now;
  const git: GitRunner = (cwd, ...args) => run('git', args, { cwd });
  const fetchJson = deps.fetchJson ?? (async (url: string, token: string) => {
    const response = await fetch(url, { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Forgejo answered ${response.status}`);
    return response.json();
  });
  // One advance per job at a time; the tick skips a job whose step is still running.
  const inFlight = new Set<string>();
  // The jobs whose check command is running. One server runs the queue for the whole workstation.
  const runningChecks = new Set<string>();
  // The process each job's current step is running, so `tjob cancel` stops it by the pid it started.
  const runningProcesses = new Map<string, { pid: number; group: boolean }>();
  // Bumped when a job is cancelled: a step that was already running must not move the job on afterwards.
  const runTokens = new Map<string, number>();

  function tokenFor(id: string): number {
    return runTokens.get(id) ?? 0;
  }

  function bumpToken(id: string): void {
    runTokens.set(id, tokenFor(id) + 1);
  }

  function stale(id: string, token: number): boolean {
    return tokenFor(id) !== token;
  }

  /** Runs a step's command and remembers its pid; `group` kills the whole detached process group. */
  async function runTracked(
    job: OrchestratorJobRow,
    command: string,
    args: string[],
    options: NonNullable<Parameters<typeof run>[2]>,
    group = false,
  ): Promise<CommandResult> {
    let pid: number | undefined;
    try {
      return await run(command, args, {
        ...options,
        onSpawn: (spawned) => {
          pid = spawned;
          runningProcesses.set(job.id, { pid: spawned, group });
        },
      });
    } finally {
      if (pid !== undefined && runningProcesses.get(job.id)?.pid === pid) runningProcesses.delete(job.id);
    }
  }

  function setStep(job: OrchestratorJobRow, step: OrchestratorMergeStep, extra: Parameters<typeof orchestratorJobsDb.update>[1] = {}): OrchestratorJobRow {
    const updated = orchestratorJobsDb.update(job.id, { merge_step: step, ...extra }) as OrchestratorJobRow;
    if (step === 'merged') {
      const reason = extra && 'last_error' in extra && extra.last_error ? String(extra.last_error) : 'merged';
      appendHubEvent({ jobId: job.id, state: 'merged', title: job.title, reason });
    }
    return updated;
  }

  /** Stops the job in the queue until `tjob retry`; the agent is told when it may be able to help. */
  async function block(job: OrchestratorJobRow, reason: string, tellAgent: boolean): Promise<void> {
    setStep(job, 'blocked', { last_error: reason });
    appendHubEvent({ jobId: job.id, state: 'blocked', title: job.title, reason });
    console.warn(`[Orchestrator] Job ${job.id} is blocked: ${reason.split('\n')[0]}`);
    if (tellAgent) {
      await deps.jobs.notify(job, `CI/CD queue: job ${job.id} is blocked.\n\n${reason}\n\nIf it is something in the code, fix it, commit, and run tjob done ${job.id} again. Infrastructure (CI, k8s, secrets, tunnels) is for a person: say so and stop.`);
    }
  }

  /** Hands the branch back to its agent with what went wrong; the agent runs `tjob done` again when fixed. */
  async function backToAgent(job: OrchestratorJobRow, message: string): Promise<void> {
    console.warn(`[Orchestrator] Job ${job.id} goes back to its agent: ${message.split('\n')[0]}`);
    appendHubEvent({ jobId: job.id, state: 'merge_failed', title: job.title, reason: message });
    await deps.jobs.reopenWithMessage(job, `CI/CD queue: ${message}\n\nFix it, commit, and run tjob done ${job.id} again. If it is infrastructure (CI, k8s, secrets, tunnels), say so and stop: that is for a person.`);
  }

  async function rebaseInProgress(cwd: string): Promise<boolean> {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const location = await git(cwd, 'rev-parse', '--git-path', dir);
      const exists = await run('test', ['-d', location.stdout.trim()], { cwd });
      if (exists.code === 0) return true;
    }
    return false;
  }

  /** Lets Gemini Flash resolve the conflicts of each stop of the rebase, then checks it left no markers. */
  async function resolveConflicts(job: OrchestratorJobRow, token: number): Promise<string | null> {
    const { command, model } = deps.config().conflictResolver;
    for (let round = 0; round < MAX_RESOLVE_ROUNDS; round += 1) {
      if (stale(job.id, token)) return null;
      if (!await rebaseInProgress(job.worktree_path)) return null;
      const conflicted = (await git(job.worktree_path, 'diff', '--name-only', '--diff-filter=U')).stdout.trim();
      if (!conflicted) {
        const proceed = await runTracked(job, 'git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
          cwd: job.worktree_path,
          env: { ...process.env, GIT_EDITOR: 'true' },
        });
        if (proceed.code !== 0 && !(await git(job.worktree_path, 'diff', '--name-only', '--diff-filter=U')).stdout.trim()) {
          return `git rebase --continue failed: ${tail(proceed.stderr, 20)}`;
        }
        continue;
      }
      const prompt = [
        `A git rebase of branch ${job.branch} onto origin/${job.base_branch} stopped on conflicts in this repository (the current directory).`,
        `The job's goal: ${job.title}`,
        `Conflicted files:\n${conflicted}`,
        'Resolve every conflict so both sides\' intent is kept: the base branch\'s newer changes and this branch\'s change.',
        'Never delete or weaken tests, checks or gates to make things fit. Do not touch files without conflicts.',
        'Then `git add` the resolved files and run `git -c core.editor=true rebase --continue`.',
        'If the conflicts cannot be resolved safely, run `git rebase --abort` and explain why.',
      ].join('\n\n');
      const resolution = await runTracked(job, command, ['-p', prompt, '--model', model, '--dangerously-skip-permissions'], {
        cwd: job.worktree_path,
        timeoutMs: 20 * 60_000,
      });
      if (stale(job.id, token)) return null;
      if (resolution.code !== 0) return `The conflict resolver failed: ${tail(resolution.stderr || resolution.stdout, 20)}`;
    }
    if (await rebaseInProgress(job.worktree_path)) return `Conflicts were still left after ${MAX_RESOLVE_ROUNDS} rounds.`;
    return null;
  }

  /** Conflict markers left in any file the branch changed. */
  async function leftoverMarkers(job: OrchestratorJobRow): Promise<string> {
    const files = (await git(job.worktree_path, 'diff', '--name-only', `origin/${job.base_branch}...HEAD`)).stdout.trim().split('\n').filter(Boolean);
    if (files.length === 0) return '';
    const found = await git(job.worktree_path, 'grep', '-n', '-E', '^(<<<<<<<|>>>>>>>)( |$)', 'HEAD', '--', ...files);
    return found.stdout.trim();
  }

  async function stepRebase(job: OrchestratorJobRow): Promise<void> {
    const token = tokenFor(job.id);
    const cwd = job.worktree_path;
    if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort'); // cut short by a restart
    if (stale(job.id, token)) return;
    const status = await git(cwd, 'status', '--porcelain');
    if (stale(job.id, token)) return;
    if (status.stdout.trim()) {
      await backToAgent(job, `the worktree has uncommitted changes:\n${tail(status.stdout, 30)}\nCommit them, or remove what should not be there.`);
      return;
    }
    const fetch = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (stale(job.id, token)) return;
    if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch.stderr, 10)}`);
    const rebase = await runTracked(job, 'git', ['rebase', `origin/${job.base_branch}`], { cwd });
    if (stale(job.id, token)) {
      if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort');
      return;
    }
    if (rebase.code !== 0) {
      const failure = await resolveConflicts(job, token);
      if (stale(job.id, token)) {
        if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort');
        return;
      }
      if (failure) {
        if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort');
        await backToAgent(job, `the rebase onto origin/${job.base_branch} stopped on conflicts the resolver could not settle (${failure.split('\n')[0]}). Run git fetch origin && git rebase origin/${job.base_branch} yourself and resolve them.`);
        return;
      }
      const markers = await leftoverMarkers(job);
      if (stale(job.id, token)) return;
      if (markers) {
        await backToAgent(job, `the conflict resolution after rebasing onto origin/${job.base_branch} left conflict markers:\n${tail(markers, 20)}`);
        return;
      }
    }
    if (stale(job.id, token)) return;
    setStep(job, 'check');
  }

  /** When the job last entered `step`: with HEAD, the idempotency key of that step's effect. */
  function enteredAt(job: OrchestratorJobRow, step: OrchestratorMergeStep): string {
    return readMergeStepHistory(job).filter((event) => event.step === step).at(-1)?.at ?? job.updated_at;
  }

  async function stepCheck(job: OrchestratorJobRow): Promise<void> {
    // Taken before the first await: the steps of one tick start side by side. No free slot: wait in `check`.
    if (runningChecks.size >= Math.max(1, deps.config().maxConcurrentChecks)) return;
    runningChecks.add(job.id);
    const token = tokenFor(job.id);
    let key: string | null = null;
    try {
      // Process-bound: a check cut by a restart is dropped and run again; one that passed is not.
      const head = await revParse(job.worktree_path, 'HEAD');
      if (stale(job.id, token)) return;
      const checkKey = `check:${job.id}:${head ?? 'unknown'}:${enteredAt(job, 'check')}`;
      const begun = outbox.begin({ key: checkKey, jobId: job.id, kind: 'merge_check', replay: 'process_bound' });
      if (begun.status === 'skipped') {
        if (begun.reason === 'done') setStep(job, 'push');
        else if (begun.reason === 'blocked') await block(job, `Its ${begun.row.kind} failed (${begun.row.last_error ?? 'unknown'}) and must be undone first.`, false);
        return;
      }
      key = checkKey;
      orchestratorJobsDb.recordMergeStep(job.id, 'check:run');
      const command = await resolveCheckCommand(job.repo_path, job.worktree_path, deps.config().checks);
      if (stale(job.id, token)) {
        outbox.finish(key, { ok: false, error: 'cancelled' });
        key = null;
        return;
      }
      if (command) {
        const logPath = getCheckLogPath(job.worktree_path);
        const started = now();
        // Below the agents' own work on the CPU: the workstation stays usable while a gate runs.
        const result = await runTracked(job, 'nice', ['-n', '10', '/bin/bash', '-lc', command], {
          cwd: job.worktree_path,
          timeoutMs: CHECK_TIMEOUT_MS,
          env: checkEnvironment(),
          logPath,
        }, true);
        if (stale(job.id, token)) {
          outbox.finish(key, { ok: false, error: 'cancelled' });
          key = null;
          return;
        }
        if (result.code !== 0 || result.timedOut || result.signal) {
          const output = result.stdout + result.stderr;
          // The tail of a long test run is its summary; the failing tests' names are further up.
          const failing = output.split('\n').filter((line) => /^\s*not ok\b/.test(line)).slice(0, 30);
          const failingList = failing.length > 0 ? `Failing:\n\n\`\`\`\n${failing.join('\n')}\n\`\`\`\n\n` : '';
          const details = `Exit code: ${result.signal ? 'none (terminated by signal)' : result.code}; duration: ${result.durationMs ?? Math.max(0, now() - started)} ms; timeout: ${result.timedOut ? `yes (CHECK_TIMEOUT_MS=${CHECK_TIMEOUT_MS})` : 'no'}; signal: ${result.signal ?? 'none'}.`;
          outbox.finish(key, { ok: false, error: `${command} failed` });
          key = null;
          await backToAgent(job, `after rebasing onto origin/${job.base_branch}, \`${command}\` failed:\n\n${failingList}\`\`\`\n${tail(output)}\n\`\`\`\n\n${details}\nFull check log: ${logPath}`);
          return;
        }
      }
      outbox.finish(key, { ok: true });
      key = null;
      if (stale(job.id, token)) return;
      setStep(job, 'push');
    } catch (error) {
      if (key) outbox.finish(key, { ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      runningChecks.delete(job.id);
    }
  }

  function waitsForDeploy(job: OrchestratorJobRow): boolean {
    return deps.config().waitForDeploy[path.basename(job.repo_path)] !== false;
  }

  /** Both a new push and recovery of an unrecorded push honor the repository policy. */
  function recordPush(job: OrchestratorJobRow, head: string): void {
    if (!waitsForDeploy(job)) {
      setStep(job, 'merged', {
        pushed_sha: head,
        deploy_waiting_since: null,
        last_error: `pushed ${head}; CI runs after merge, not awaited`,
      });
      return;
    }
    setStep(job, 'deploy', { pushed_sha: head, deploy_waiting_since: new Date(now()).toISOString(), last_error: null });
  }

  /**
   * A stacked job (its base is another job's branch) lands where its parent lands: pushed onto the parent's branch it
   * would only count as merged there. It waits while the parent is on its way, follows the parent's base once the parent
   * is merged, and is blocked when the parent was cancelled or failed (its branch never reaches a landing branch).
   */
  async function landsOnItsBase(job: OrchestratorJobRow): Promise<boolean> {
    for (let current = job, depth = 0; depth < 10; depth += 1) {
      const parent = orchestratorJobsDb.list().find((other) =>
        other.id !== current.id && other.repo_path === current.repo_path && other.branch === current.base_branch);
      if (!parent) return true;
      if (parent.merge_step === 'merged') {
        const note = `base was job ${parent.id}'s branch ${current.base_branch}, merged into ${parent.base_branch}: lands on ${parent.base_branch}`;
        console.warn(`[Orchestrator] Job ${job.id}: ${note}`);
        current = orchestratorJobsDb.update(job.id, { base_branch: parent.base_branch, last_error: note }) as OrchestratorJobRow;
        continue;
      }
      if (parent.state === 'cancelled' || parent.state === 'failed') {
        await block(job, `origin/${current.base_branch} is job ${parent.id}'s branch, and that job is ${parent.state}: a push there never reaches ${parent.base_branch}, so it would not be merged. Land job ${parent.id}, or create a job based on ${parent.base_branch} with these commits.`, false);
        return false;
      }
      return false; // the parent is still on its way: this job lands after it
    }
    return false;
  }

  /** Recorded in the outbox (safe to replay): a restart cut anywhere in it pushes or records the push once. */
  async function stepPush(job: OrchestratorJobRow): Promise<void> {
    const head = await revParse(job.worktree_path, 'HEAD');
    if (!head) throw new Error('Cannot resolve HEAD before pushing');
    const key = `push:${job.id}:${head}:${enteredAt(job, 'push')}`;
    const ran = await outbox.run({ key, jobId: job.id, kind: 'push', replay: 'safe', payload: { head } }, () => pushHead(job, head));
    if (ran.status === 'skipped' && ran.reason === 'blocked') {
      await block(job, `Its ${ran.row.kind} failed (${ran.row.last_error ?? 'unknown'}) and must be undone first.`, false);
    } else if (ran.status === 'skipped' && ran.reason === 'done') {
      await pushHead(job, head); // idempotent: records a push already on origin
    }
  }

  /**
   * Startup: a push the old process left running. At `push`, the step runs again (it records a push already on
   * origin, else pushes). Past it with a pushed commit origin does not have, the job goes back to `push`.
   */
  const replayPush: EffectReplayHandler = async (row) => {
    const job = row.job_id ? orchestratorJobsDb.get(row.job_id) : null;
    if (!job) return;
    if ((job.merge_step === 'deploy' || job.merge_step === 'merged') && job.pushed_sha) {
      const fetched = await git(job.worktree_path, 'fetch', '--quiet', 'origin', job.base_branch);
      if (fetched.code !== 0) throw new Error(`git fetch failed: ${tail(fetched.stderr, 10)}`);
      if ((await git(job.worktree_path, 'merge-base', '--is-ancestor', job.pushed_sha, `origin/${job.base_branch}`)).code === 0) return;
      const reverted = setStep(job, 'push', { pushed_sha: null, last_error: `the recorded push of ${job.pushed_sha.slice(0, 8)} is not on origin/${job.base_branch} after a restart; pushing again` });
      const head = await revParse(reverted.worktree_path, 'HEAD');
      if (head) await pushHead(reverted, head);
      return;
    }
    if (job.merge_step !== 'push') return;
    const head = await revParse(job.worktree_path, 'HEAD');
    if (!head) throw new Error('Cannot resolve HEAD before pushing');
    await pushHead(job, head);
  };

  async function pushHead(job: OrchestratorJobRow, head: string): Promise<void> {
    const cwd = job.worktree_path;
    const fetch = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch.stderr, 10)}`);
    // Pushed already (a restart came between the push and recording it).
    if ((await git(cwd, 'merge-base', '--is-ancestor', head, `origin/${job.base_branch}`)).code === 0) {
      recordPush(job, head);
      return;
    }
    const rebaseAgain = (reason: string) => {
      const attempts = job.merge_attempts + 1;
      if (attempts >= MAX_PUSH_ATTEMPTS) return block(job, `${reason} ${attempts} times in a row.`, false);
      setStep(job, 'rebase', { merge_attempts: attempts });
      return Promise.resolve();
    };
    // Base moved since the rebase: rebase and check again rather than push a merge nobody tested.
    if ((await git(cwd, 'merge-base', '--is-ancestor', `origin/${job.base_branch}`, 'HEAD')).code !== 0) {
      await rebaseAgain(`origin/${job.base_branch} moved before the push`);
      return;
    }
    const push = await git(cwd, 'push', 'origin', `HEAD:refs/heads/${job.base_branch}`);
    if (push.code !== 0) {
      if (/rejected|non-fast-forward|fetch first/i.test(push.stderr)) {
        await rebaseAgain('The push was rejected');
        return;
      }
      // A pre-push hook (the project's own checks) or the remote refused it.
      await backToAgent(job, `git push to ${job.base_branch} failed:\n\n\`\`\`\n${tail(push.stderr, 40)}\n\`\`\``);
      return;
    }
    // Merged only when origin says so: a push that exits 0 but leaves the commits off the base is not a merge.
    const after = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (after.code !== 0) throw new Error(`git fetch after the push failed: ${tail(after.stderr, 10)}`);
    if ((await git(cwd, 'merge-base', '--is-ancestor', head, `origin/${job.base_branch}`)).code !== 0) {
      await block(job, `git push to ${job.base_branch} exited 0, but ${head.slice(0, 8)} is not on origin/${job.base_branch} afterwards:\n\n\`\`\`\n${tail(push.stderr, 20)}\n\`\`\``, false);
      return;
    }
    recordPush(job, head);
  }

  /**
   * The runs of a newer commit on the base branch that contains this job's: Forgejo's `cancel-in-progress`
   * cancels a commit's run when the next push comes quickly, and the newer run then tests both. The green one
   * wins; else one still running; else a failed one. Null: no descendant on the base branch has runs.
   */
  async function supersedingRuns(job: OrchestratorJobRow, runs: DeployRun[]): Promise<{ sha: string; runs: DeployRun[]; outcome: 'success' | 'running' | 'failure' } | null> {
    const candidates = [...new Set(runs.map((record) => record.commit_sha))]
      .filter((sha): sha is string => Boolean(sha && sha !== job.pushed_sha));
    if (candidates.length === 0) return null;
    const cwd = job.worktree_path;
    const fetched = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${tail(fetched.stderr, 10)}`);
    const found: Array<{ sha: string; runs: DeployRun[]; outcome: 'success' | 'running' | 'failure' }> = [];
    for (const sha of candidates) {
      if ((await git(cwd, 'merge-base', '--is-ancestor', job.pushed_sha!, sha)).code !== 0
        || (await git(cwd, 'merge-base', '--is-ancestor', sha, `origin/${job.base_branch}`)).code !== 0) continue;
      const commitRuns = runs.filter((record) => record.commit_sha === sha);
      // A successful workflow alone is insufficient if another workflow is failing or still running.
      const outcome = commitRuns.some((record) => !FINISHED_RUN_STATUSES.has(String(record.status))) ? 'running'
        : commitRuns.every((record) => record.status === 'success' || record.status === 'skipped')
          && commitRuns.some((record) => record.status === 'success') ? 'success' : 'failure';
      found.push({ sha, runs: commitRuns, outcome });
    }
    return found.find((entry) => entry.outcome === 'success')
      ?? found.find((entry) => entry.outcome === 'running')
      ?? found[0]
      ?? null;
  }

  function describeRuns(records: DeployRun[]): string {
    return records.map((record) => `${record.workflow_id}#${record.id}: ${record.status}`).join(', ');
  }

  async function stepDeploy(job: OrchestratorJobRow): Promise<void> {
    // A policy change also releases jobs already watching a pushed commit.
    if (!waitsForDeploy(job) && job.pushed_sha) {
      recordPush(job, job.pushed_sha);
      return;
    }
    const since = Date.parse(job.deploy_waiting_since ?? '') || now();
    const origin = await readOriginRepository(job.repo_path);
    const { apiUrl, tokenFile } = deps.config().forgejo;
    const token = await readFile(tokenFile, 'utf8').then((value) => value.trim()).catch(() => '');
    if (!origin || !token || !job.pushed_sha) {
      setStep(job, 'merged');
      return;
    }
    const body = await fetchJson(`${apiUrl}/repos/${origin.owner}/${origin.repo}/actions/runs?limit=30`, token) as {
      workflow_runs?: DeployRun[];
    };
    const allRuns = body.workflow_runs ?? [];
    const runs = allRuns.filter((runRecord) => runRecord.commit_sha === job.pushed_sha);
    const running = runs.some((runRecord) => !FINISHED_RUN_STATUSES.has(String(runRecord.status)));
    const failed = runs.filter((runRecord) => runRecord.status === 'failure' || runRecord.status === 'cancelled');
    const superseded = runs.length === 0 || failed.length > 0 ? await supersedingRuns(job, allRuns) : null;
    if (superseded?.outcome === 'success') {
      const note = `Deployed by superseding commit ${superseded.sha} on origin/${job.base_branch}: ${describeRuns(superseded.runs)}.`;
      setStep(job, 'merged', { last_error: note });
      console.info(`[Orchestrator] Job ${job.id}: ${note}`);
      return;
    }
    // Only cancelled (not failed): a newer push cancelled this run, and that push's run decides.
    const onlyCancelled = !running && failed.length > 0 && failed.every((runRecord) => runRecord.status === 'cancelled');
    if (runs.length === 0) {
      if (now() - since > NO_CI_GRACE_MS) setStep(job, 'merged');
      return;
    }
    if (running || (onlyCancelled && superseded?.outcome === 'running')) {
      if (now() - since > DEPLOY_TIMEOUT_MS) await block(job, `The deploy of ${job.pushed_sha.slice(0, 8)} is still running after an hour.`, false);
      return;
    }
    if (failed.length > 0) {
      const newer = onlyCancelled && superseded
        ? ` (superseded by ${superseded.sha.slice(0, 8)}, whose run failed: ${describeRuns(superseded.runs)})`
        : '';
      await block(job, `The pushed commit ${job.pushed_sha.slice(0, 8)} is on origin/${job.base_branch}, but its CI/deploy run ${describeRuns(failed)}${newer}. Rerun it in Forgejo, then tjob retry ${job.id}.`, true);
      return;
    }
    setStep(job, 'merged', { last_error: null });
  }

  async function advance(job: OrchestratorJobRow): Promise<void> {
    switch (job.merge_step) {
      case 'queued': {
        if (deps.jobs.isSessionBusy(job)) return; // the agent's last turn is still going
        if (!await landsOnItsBase(job)) return;
        const laneTaken = orchestratorJobsDb.listInMergeQueue().some((other) =>
          other.id !== job.id && other.repo_path === job.repo_path && LANE_STEPS.includes(other.merge_step));
        if (!laneTaken) setStep(job, 'rebase');
        return;
      }
      case 'rebase': return stepRebase(job);
      case 'check': return stepCheck(job);
      case 'push': return stepPush(job);
      case 'deploy': return stepDeploy(job);
      default:
    }
  }

  return {
    /** One pass over the queue; each job advances at most one step. Steps of different jobs run side by side. */
    tick(): Promise<void> {
      const advancing: Array<Promise<void>> = [];
      for (const job of orchestratorJobsDb.listInMergeQueue()) {
        if (inFlight.has(job.id)) continue;
        inFlight.add(job.id);
        advancing.push(advance(job)
          .catch((error) => {
            // Transient (network, fetch): recorded, and the same step runs again on the next tick.
            const message = error instanceof Error ? error.message : String(error);
            orchestratorJobsDb.update(job.id, { last_error: message });
            console.warn(`[Orchestrator] Job ${job.id} ${job.merge_step} will be retried: ${message}`);
          })
          .finally(() => inFlight.delete(job.id)));
      }
      // Resolves when this pass's steps are over; the loop does not wait for it.
      return Promise.all(advancing).then(() => undefined);
    },

    /** Startup: replay handlers for the safe effects the queue records. */
    effectHandlers(): { push: EffectReplayHandler } {
      return { push: replayPush };
    },

    /**
     * `tjob cancel` for a job in the queue: before the push, stop the step it is running (by the pid the queue
     * started), take it out of the queue and keep its branch. A push cannot be undone safely, so from `push` on
     * the job is left to merge.
     */
    async cancel(job: OrchestratorJobRow, options: { noPush?: boolean } = {}): Promise<{ cancelled: boolean; reason?: string }> {
      if (['push', 'deploy', 'merged'].includes(job.merge_step)) {
        return { cancelled: false, reason: `Job ${job.id} is already pushing; it will merge` };
      }
      if (!['queued', 'rebase', 'check'].includes(job.merge_step)) {
        return { cancelled: false, reason: `Job ${job.id} is not in the CI/CD queue (${job.merge_step})` };
      }
      const step = job.merge_step;
      bumpToken(job.id);
      const running = runningProcesses.get(job.id);
      if (running) {
        const signal = (name: NodeJS.Signals) => {
          try { process.kill(running.group ? -running.pid : running.pid, name); } catch { /* already exited */ }
        };
        signal('SIGTERM');
        const escalation = setTimeout(() => signal('SIGKILL'), 1_000);
        escalation.unref?.();
      }
      if (step === 'rebase') {
        try { await git(job.worktree_path, 'rebase', '--abort'); } catch { /* no rebase in progress */ }
      }
      // State and the --no-push override land in one UPDATE: a crash cannot leave a cancelled job that cleanup would push.
      orchestratorJobsDb.update(job.id, { state: 'cancelled', merge_step: 'none', in_turn: 0, last_error: null, cancel_no_push: options.noPush === true ? 1 : 0 });
      orchestratorJobsDb.recordMergeStep(job.id, 'cancelled', new Date(now()).toISOString(), 'tjob cancel');
      appendHubEvent({ jobId: job.id, state: 'cancelled', title: job.title, reason: `cancelled from the CI/CD queue at ${step}; branch kept` });
      return { cancelled: true };
    },

    /** `tjob retry`: a blocked job goes on from where it was: watching its deploy if it was pushed, else from the rebase. */
    retry(job: OrchestratorJobRow): OrchestratorJobRow {
      return setStep(job, job.pushed_sha ? 'deploy' : 'queued', {
        merge_attempts: 0,
        last_error: null,
        ...(job.pushed_sha ? { deploy_waiting_since: new Date(now()).toISOString() } : {}),
      });
    },
  };
}
