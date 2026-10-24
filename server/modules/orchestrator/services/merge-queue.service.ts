import { readFile } from 'node:fs/promises';

import { orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow, OrchestratorMergeStep } from '@/modules/database/index.js';

import type { JobsService } from './jobs.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';
import {
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
/** Rounds of conflict resolution before a rebase is given up. */
const MAX_RESOLVE_ROUNDS = 8;

/** The steps that hold a repository's lane: one job at a time goes from rebase to push. */
const LANE_STEPS: OrchestratorMergeStep[] = ['rebase', 'check', 'push'];

type GitRunner = (cwd: string, ...args: string[]) => Promise<CommandResult>;

/** Forgejo run statuses that are final. */
const FINISHED_RUN_STATUSES = new Set(['success', 'failure', 'cancelled', 'skipped']);

/**
 * Used by the Orchestrator module. Takes a finished job's branch to its base
 * branch: rebase onto the latest base (Gemini Flash resolves conflicts),
 * the project's checks, push, then the deploy Forgejo runs for it.
 *
 * Every step is recorded before it runs, and each can be run again: a server
 * restart, a push rejected because another job got there first, or a deploy
 * going on in the same repository, all resume from the step the job is at.
 */
export function createMergeQueueService(deps: {
  jobs: JobsService;
  config: () => OrchestratorConfig;
  run?: typeof runCommand;
  fetchJson?: (url: string, token: string) => Promise<unknown>;
  now?: () => number;
}) {
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

  function setStep(job: OrchestratorJobRow, step: OrchestratorMergeStep, extra: Parameters<typeof orchestratorJobsDb.update>[1] = {}): OrchestratorJobRow {
    return orchestratorJobsDb.update(job.id, { merge_step: step, ...extra }) as OrchestratorJobRow;
  }

  /** Stops the job in the queue until `tjob retry`; the agent is told when it may be able to help. */
  async function block(job: OrchestratorJobRow, reason: string, tellAgent: boolean): Promise<void> {
    setStep(job, 'blocked', { last_error: reason });
    console.warn(`[Orchestrator] Job ${job.id} is blocked: ${reason.split('\n')[0]}`);
    if (tellAgent) {
      await deps.jobs.notify(job, `CI/CD queue: job ${job.id} is blocked.\n\n${reason}\n\nIf it is something in the code, fix it, commit, and run tjob done ${job.id} again. Infrastructure (CI, k8s, secrets, tunnels) is for a person: say so and stop.`);
    }
  }

  /** Hands the branch back to its agent with what went wrong; the agent runs `tjob done` again when fixed. */
  async function backToAgent(job: OrchestratorJobRow, message: string): Promise<void> {
    console.warn(`[Orchestrator] Job ${job.id} goes back to its agent: ${message.split('\n')[0]}`);
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
  async function resolveConflicts(job: OrchestratorJobRow): Promise<string | null> {
    const { command, model } = deps.config().conflictResolver;
    for (let round = 0; round < MAX_RESOLVE_ROUNDS; round += 1) {
      if (!await rebaseInProgress(job.worktree_path)) return null;
      const conflicted = (await git(job.worktree_path, 'diff', '--name-only', '--diff-filter=U')).stdout.trim();
      if (!conflicted) {
        const proceed = await run('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: job.worktree_path });
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
      const resolution = await run(command, ['-p', prompt, '--model', model, '--dangerously-skip-permissions'], {
        cwd: job.worktree_path,
        timeoutMs: 20 * 60_000,
      });
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
    const cwd = job.worktree_path;
    if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort'); // cut short by a restart
    const status = await git(cwd, 'status', '--porcelain');
    if (status.stdout.trim()) {
      await backToAgent(job, `the worktree has uncommitted changes:\n${tail(status.stdout, 30)}\nCommit them, or remove what should not be there.`);
      return;
    }
    const fetch = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch.stderr, 10)}`);
    const rebase = await git(cwd, 'rebase', `origin/${job.base_branch}`);
    if (rebase.code !== 0) {
      const failure = await resolveConflicts(job);
      if (failure) {
        if (await rebaseInProgress(cwd)) await git(cwd, 'rebase', '--abort');
        await backToAgent(job, `the rebase onto origin/${job.base_branch} stopped on conflicts the resolver could not settle (${failure.split('\n')[0]}). Run git fetch origin && git rebase origin/${job.base_branch} yourself and resolve them.`);
        return;
      }
      const markers = await leftoverMarkers(job);
      if (markers) {
        await backToAgent(job, `the conflict resolution after rebasing onto origin/${job.base_branch} left conflict markers:\n${tail(markers, 20)}`);
        return;
      }
    }
    setStep(job, 'check');
  }

  async function stepCheck(job: OrchestratorJobRow): Promise<void> {
    const command = await resolveCheckCommand(job.repo_path, job.worktree_path, deps.config().checks);
    if (command) {
      const result = await run(command, [], { cwd: job.worktree_path, shell: true, timeoutMs: 45 * 60_000 });
      if (result.code !== 0) {
        await backToAgent(job, `after rebasing onto origin/${job.base_branch}, \`${command}\` failed:\n\n\`\`\`\n${tail(result.stdout + result.stderr)}\n\`\`\``);
        return;
      }
    }
    setStep(job, 'push');
  }

  async function stepPush(job: OrchestratorJobRow): Promise<void> {
    const cwd = job.worktree_path;
    const head = await revParse(cwd, 'HEAD');
    const fetch = await git(cwd, 'fetch', '--quiet', 'origin', job.base_branch);
    if (fetch.code !== 0) throw new Error(`git fetch failed: ${tail(fetch.stderr, 10)}`);
    // Pushed already (a restart came between the push and recording it).
    if (head && (await git(cwd, 'merge-base', '--is-ancestor', head, `origin/${job.base_branch}`)).code === 0) {
      setStep(job, 'deploy', { pushed_sha: head, deploy_waiting_since: new Date(now()).toISOString() });
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
    setStep(job, 'deploy', { pushed_sha: head, deploy_waiting_since: new Date(now()).toISOString(), last_error: null });
  }

  async function stepDeploy(job: OrchestratorJobRow): Promise<void> {
    const since = Date.parse(job.deploy_waiting_since ?? '') || now();
    const origin = await readOriginRepository(job.repo_path);
    const { apiUrl, tokenFile } = deps.config().forgejo;
    const token = await readFile(tokenFile, 'utf8').then((value) => value.trim()).catch(() => '');
    if (!origin || !token || !job.pushed_sha) {
      setStep(job, 'merged');
      return;
    }
    const body = await fetchJson(`${apiUrl}/repos/${origin.owner}/${origin.repo}/actions/runs?limit=30`, token) as {
      workflow_runs?: Array<{ commit_sha?: string; status?: string; workflow_id?: string; id?: number }>;
    };
    const runs = (body.workflow_runs ?? []).filter((runRecord) => runRecord.commit_sha === job.pushed_sha);
    if (runs.length === 0) {
      if (now() - since > NO_CI_GRACE_MS) setStep(job, 'merged');
      return;
    }
    if (runs.some((runRecord) => !FINISHED_RUN_STATUSES.has(String(runRecord.status)))) {
      if (now() - since > DEPLOY_TIMEOUT_MS) await block(job, `The deploy of ${job.pushed_sha.slice(0, 8)} is still running after an hour.`, false);
      return;
    }
    const failed = runs.filter((runRecord) => runRecord.status === 'failure' || runRecord.status === 'cancelled');
    if (failed.length > 0) {
      await block(job, `The pushed commit ${job.pushed_sha.slice(0, 8)} is on origin/${job.base_branch}, but its CI/deploy run ${failed.map((r) => `${r.workflow_id}#${r.id}: ${r.status}`).join(', ')}. Rerun it in Forgejo, then tjob retry ${job.id}.`, true);
      return;
    }
    setStep(job, 'merged', { last_error: null });
  }

  async function advance(job: OrchestratorJobRow): Promise<void> {
    switch (job.merge_step) {
      case 'queued': {
        if (deps.jobs.isSessionBusy(job)) return; // the agent's last turn is still going
        const laneTaken = orchestratorJobsDb.listInMergeQueue().some((other) =>
          other.id !== job.id && other.repo_path === job.repo_path && LANE_STEPS.includes(other.merge_step));
        if (!laneTaken) setStep(job, 'rebase');
        return;
      }
      case 'rebase': return stepRebase(job);
      case 'check': return stepCheck(job);
      case 'push': {
        // Waits for the deploy of the previous push in this repository.
        const deploying = orchestratorJobsDb.listInMergeQueue().some((other) =>
          other.id !== job.id && other.repo_path === job.repo_path && other.merge_step === 'deploy');
        if (!deploying) await stepPush(job);
        return;
      }
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
