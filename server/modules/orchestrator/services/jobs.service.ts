import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  orchestratorJobsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorJobRow } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

import { pickBackend } from './balancer.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';
import {
  hasCommitsAhead,
  isDirty,
  prepareWorktree,
  resolveBaseBranch,
  resolveMainCheckout,
} from './workspace.service.js';

/** Jobs that hold a backend's slot: being set up, or with an agent on them (working or waiting for an answer). */
const SLOT_STATES = ['preparing', 'active'] as const;

const BACKENDS: OrchestratorBackend[] = ['claude', 'codex', 'glm'];

/** What a job looks like to its callers: the row, plus what its session is doing right now. */
export type OrchestratorJobView = OrchestratorJobRow & {
  /** working while its session has a turn going, waiting when the agent stopped for an answer. */
  activity: 'working' | 'waiting' | null;
  model: string | null;
};

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'job';
}

/** Whether the session's current run began after `sqliteTimestamp` (UTC, second precision, so a second of slack). */
function startedAfter(sessionId: string, sqliteTimestamp: string): boolean {
  const run = chatRunRegistry.getRun(sessionId);
  const at = Date.parse(`${sqliteTimestamp.replace(' ', 'T')}Z`);
  return Boolean(run && Number.isFinite(at) && run.startedAt > at + 1_000);
}

function firstUserId(): number | null {
  const user = userDb.getFirstUser() as { id?: number } | null | undefined;
  return typeof user?.id === 'number' ? user.id : null;
}

/** The first turn of a job: the task, plus how a job ends. */
function buildJobPrompt(job: OrchestratorJobRow, label: string): string {
  return [
    `You are ${label}, working on job ${job.id} — "${job.title}".`,
    `You are in your own git worktree (${job.worktree_path}), on branch ${job.branch}, made from origin/${job.base_branch} of ${job.repo_path}.`,
    '',
    job.prompt.trim(),
    '',
    'How this job works:',
    "- Follow the repository's AGENTS.md / CLAUDE.md. Shared memory (decisions, context) is in Mem0 through the tripam-reasoning MCP when you have it.",
    '- Commit your work on this branch with a descriptive, topic-led message. Never push, never use --no-verify, never touch secrets, k8s, CI or tunnels.',
    '- If you need a decision from the person, ask it and end your turn: they answer in this session. Being stopped mid-turn is not the end of the job: a change of direction or more context is coming.',
    `- Only when the person tells you they do not want this job anymore, run: tjob cancel ${job.id} (and tjob resume ${job.id} if they want it back later).`,
    `- When the code is complete, committed, and the project's checks pass, run: tjob done ${job.id}`,
    `  That hands the branch to the CI/CD queue (rebase onto ${job.base_branch}, checks, push, deploy). If anything fails there, you get a message here.`,
  ].join('\n');
}

/**
 * Used by the Orchestrator routes and the CI/CD queue. Owns a job from the
 * request to the moment its code is handed to the CI/CD queue: the backend
 * pick, the worktree, the session, and what the session is doing.
 */
export function createJobsService(deps: {
  runtime: ProviderRuntimeGateway;
  config: () => OrchestratorConfig;
}) {
  // A job is set up once at a time; a tick that finds it mid-preparation leaves it.
  const preparing = new Set<string>();

  function loads(): Record<OrchestratorBackend, number> {
    const counts: Record<OrchestratorBackend, number> = { claude: 0, codex: 0, glm: 0 };
    for (const job of orchestratorJobsDb.listByState([...SLOT_STATES])) {
      if (job.backend) counts[job.backend] += 1;
    }
    return counts;
  }

  function caps(config: OrchestratorConfig): Record<OrchestratorBackend, number> {
    return Object.fromEntries(BACKENDS.map((backend) => [backend, config.backends[backend].cap])) as Record<OrchestratorBackend, number>;
  }

  function view(job: OrchestratorJobRow): OrchestratorJobView {
    const processing = job.session_id ? chatRunRegistry.isProcessing(job.session_id) : false;
    const session = job.session_id ? sessionsDb.getSessionById(job.session_id) : null;
    return {
      ...job,
      activity: job.state === 'active' ? (processing ? 'working' : 'waiting') : null,
      model: (session as { model?: string | null } | null)?.model ?? null,
    };
  }

  /** Starts a turn in the job's session. False when the session is busy or gone. */
  async function sendTurn(job: OrchestratorJobRow, content: string): Promise<boolean> {
    if (!job.session_id || !job.backend) return false;
    const backend = deps.config().backends[job.backend];
    orchestratorJobsDb.update(job.id, { in_turn: 1 });
    const turn = runDetachedChatTurn({
      sessionId: job.session_id,
      userId: firstUserId(),
      content,
      options: {
        model: backend.model,
        ...(backend.effort ? { effort: backend.effort } : {}),
        permissionMode: 'bypassPermissions',
      },
    }, { runtime: deps.runtime });
    // Settles when the turn ends; only a turn that never started is reported here.
    const started = await Promise.race([
      turn.then((result) => result.started),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
    ]);
    if (!started) orchestratorJobsDb.update(job.id, { in_turn: 0 });
    return started;
  }

  /** Gives a queued (or half-prepared) job its backend, worktree and session, then starts its first turn. */
  async function start(job: OrchestratorJobRow, backend: OrchestratorBackend): Promise<void> {
    const config = deps.config();
    const backendConfig = config.backends[backend];
    preparing.add(job.id);
    orchestratorJobsDb.update(job.id, { backend, state: 'preparing', last_error: null });
    try {
      await prepareWorktree({
        repoPath: job.repo_path,
        worktreePath: job.worktree_path,
        branch: job.branch,
        baseBranch: job.base_branch,
      });

      let sessionId = job.session_id;
      if (!sessionId) {
        projectsDb.createProjectPath(job.worktree_path, `${path.basename(job.repo_path)} · ${job.title}`);
        sessionId = sessionsService.createAppSession(backendConfig.provider, job.worktree_path, job.title).sessionId;
        sessionsDb.updateSessionCustomName(sessionId, `${backendConfig.label} · ${job.title}`);
        sessionsDb.setSessionModel(sessionId, backendConfig.model);
        if (backendConfig.effort) sessionsDb.setSessionEffort(sessionId, backendConfig.effort);
      }
      const ready = orchestratorJobsDb.update(job.id, { session_id: sessionId, state: 'active' }) as OrchestratorJobRow;
      await sendTurn(ready, buildJobPrompt(ready, backendConfig.label));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Job ${job.id} could not start`, message);
      orchestratorJobsDb.update(job.id, { state: 'failed', last_error: message });
    } finally {
      preparing.delete(job.id);
    }
  }

  return {
    loads,

    list(): OrchestratorJobView[] {
      return orchestratorJobsDb.list().map(view);
    },

    get(id: string): OrchestratorJobView | null {
      const job = orchestratorJobsDb.get(id);
      return job ? view(job) : null;
    },

    /** Records a job; the next tick gives it a backend (or it waits in the queue). */
    async create(input: {
      title: string;
      prompt: string;
      repoPath: string;
      backend: OrchestratorBackend | null;
      baseBranch: string | null;
    }): Promise<OrchestratorJobView> {
      const config = deps.config();
      const repoPath = path.resolve(input.repoPath);
      if (!repoPath.startsWith(path.resolve(config.workspacesRoot) + path.sep)) {
        throw new AppError(`repo must be inside ${config.workspacesRoot}`, { code: 'REPO_OUTSIDE_WORKSPACES', statusCode: 400 });
      }
      const repoName = path.basename(repoPath);
      const baseBranch = input.baseBranch ?? await resolveBaseBranch(repoPath, config.baseBranches[repoName]);
      const id = randomUUID().slice(0, 8);
      const job = orchestratorJobsDb.create({
        id,
        title: input.title,
        prompt: input.prompt,
        repoPath,
        baseBranch,
        requestedBackend: input.backend,
        branch: `job/${slugify(input.title)}-${id}`,
        worktreePath: path.join(config.worktreesRoot, repoName, id),
      });
      await this.tick();
      return view(orchestratorJobsDb.get(job.id) ?? job);
    },

    /**
     * "Send to load balancer" from a session's composer or queue: the message
     * becomes a job in the repository the session works in (its main
     * checkout), instead of waiting for that session.
     */
    async createFromSession(input: { sessionId: string; content: string; backend: OrchestratorBackend | null }): Promise<OrchestratorJobView> {
      const session = sessionsDb.getSessionById(input.sessionId) as { project_path?: string | null; custom_name?: string | null } | null;
      if (!session?.project_path) {
        throw new AppError(`Session ${input.sessionId} was not found`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      const repoPath = await resolveMainCheckout(session.project_path);
      if (!repoPath) {
        throw new AppError(`${session.project_path} is not a git repository`, { code: 'NOT_A_REPOSITORY', statusCode: 400 });
      }
      const firstLine = input.content.trim().split('\n').find((line) => line.trim())?.trim() ?? 'Job';
      const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
      const origin = session.custom_name ? ` "${session.custom_name}"` : '';
      return this.create({
        title,
        prompt: `${input.content.trim()}\n\n(Sent to the load balancer from the session${origin}, working in ${session.project_path}.)`,
        repoPath,
        backend: input.backend,
        baseBranch: null,
      });
    },

    /**
     * Called by the agent (`tjob done <id>`) when its code is complete. The
     * work must be committed, and there must be some; then the job leaves its
     * backend's slot and joins the CI/CD queue.
     */
    async markDone(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      // Done again after a blocked or merged merge: a fix on top goes through the queue as well.
      const again = job.state === 'done' && (job.merge_step === 'blocked' || job.merge_step === 'merged');
      if (job.state !== 'active' && !again) {
        throw new AppError(`Job ${id} is ${job.state} (${job.merge_step}), not active`, { code: 'JOB_NOT_ACTIVE', statusCode: 409 });
      }
      if (await isDirty(job.worktree_path)) {
        throw new AppError('The worktree has uncommitted changes: commit them first', { code: 'JOB_DIRTY', statusCode: 409 });
      }
      if (!await hasCommitsAhead(job.worktree_path, job.base_branch)) {
        throw new AppError(`The branch has no commits ahead of origin/${job.base_branch}`, { code: 'JOB_EMPTY', statusCode: 409 });
      }
      orchestratorJobsDb.update(id, { state: 'done', merge_step: 'queued', merge_attempts: 0, pushed_sha: null, last_error: null });
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /**
     * `tjob cancel`: the person said they do not want the job anymore (in
     * its session, where its agent runs this, or from a shell). It frees its
     * slot and leaves the CI/CD queue; worktree, branch and session are kept.
     * A merge already past its rebase is not taken back.
     */
    async cancel(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      if (['rebase', 'check', 'push', 'deploy', 'merged'].includes(job.merge_step)) {
        throw new AppError(`Job ${id} is already in the CI/CD queue (${job.merge_step})`, { code: 'JOB_MERGING', statusCode: 409 });
      }
      orchestratorJobsDb.update(id, { state: 'cancelled', merge_step: 'none' });
      await this.tick();
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /** `tjob resume`: a cancelled job takes a slot again; a failed one is set up again. */
    async resume(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      if (job.state === 'cancelled') orchestratorJobsDb.update(id, { state: job.session_id ? 'active' : 'queued' });
      if (job.state === 'failed') orchestratorJobsDb.update(id, { state: 'queued', last_error: null });
      await this.tick();
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /** Used by the CI/CD queue: hands a failure back to the job's agent, which takes its slot again. */
    async reopenWithMessage(job: OrchestratorJobRow, message: string): Promise<boolean> {
      orchestratorJobsDb.update(job.id, { state: 'active', merge_step: 'none' });
      return sendTurn(orchestratorJobsDb.get(job.id) as OrchestratorJobRow, message);
    },

    /** Used by the CI/CD queue to tell the job's agent something, leaving the job where it is. */
    async notify(job: OrchestratorJobRow, message: string): Promise<boolean> {
      return sendTurn(job, message);
    },

    /** Used by the CI/CD queue to wait for an agent's last turn before touching its worktree. */
    isSessionBusy(job: OrchestratorJobRow): boolean {
      return Boolean(job.session_id && (chatRunRegistry.isProcessing(job.session_id) || deps.runtime.hasBackgroundWork(job.session_id)));
    },

    /**
     * A turn ended, finished or stopped: either way the job keeps its slot. A
     * stop is a change of direction or more context coming, not the end of
     * the job; that takes the person saying so (`tjob cancel`).
     */
    handleRunCompleted(completion: { appSessionId: string; exitCode: number; aborted: boolean }): void {
      const job = orchestratorJobsDb.getBySessionId(completion.appSessionId);
      if (!job) return;
      orchestratorJobsDb.update(job.id, {
        in_turn: 0,
        ...(completion.exitCode !== 0 && !completion.aborted ? { last_error: `The last turn ended with exit code ${completion.exitCode}` } : {}),
      });
    },

    /**
     * One pass of the balancer: follows what sessions are doing, then gives
     * queued jobs a backend while there is room, oldest first.
     */
    async tick(): Promise<void> {
      for (const job of orchestratorJobsDb.listByState(['active', 'done'])) {
        if (!job.session_id || !chatRunRegistry.isProcessing(job.session_id)) continue;
        if (job.state === 'done' && job.merge_step === 'queued' && startedAfter(job.session_id, job.updated_at)) {
          // A new turn after `tjob done` (not the turn that called it), before
          // the queue took the branch: the work is not finished after all.
          orchestratorJobsDb.update(job.id, { state: 'active', merge_step: 'none', in_turn: 1 });
        } else if (job.state === 'active' && !job.in_turn) orchestratorJobsDb.update(job.id, { in_turn: 1 });
      }

      const config = deps.config();
      for (const job of orchestratorJobsDb.listByState(['queued'])) {
        const backend = pickBackend(job.requested_backend, loads(), caps(config), config.fallbackBackend);
        if (!backend) continue;
        void start(job, backend);
      }
    },

    /**
     * After a restart: preparation that was cut short is finished, and a job
     * whose agent was mid-turn is told to go on where it was.
     */
    async recover(): Promise<void> {
      for (const job of orchestratorJobsDb.listByState(['preparing'])) {
        if (job.backend && !preparing.has(job.id)) void start(job, job.backend);
      }
      for (const job of orchestratorJobsDb.listByState(['active'])) {
        if (!job.in_turn || !job.session_id || chatRunRegistry.isProcessing(job.session_id)) continue;
        await sendTurn(job, 'The CLI server restarted while you were working. Check the state of the worktree (git status, git log) and continue where you left off.');
      }
    },
  };
}

/** The jobs service's API, for the CI/CD queue and the routes. */
export type JobsService = ReturnType<typeof createJobsService>;
