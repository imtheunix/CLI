import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  orchestratorEffectsDb,
  orchestratorJobsDb,
  projectsDb,
  readMergeStepHistory,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorEffectRow, OrchestratorJobRow, OrchestratorMergeStepEvent } from '@/modules/database/index.js';
import { abortTurn } from '@/modules/detached-turns/index.js';
import {
  probeZcodeLogin,
  providerAuthService,
  providerTokenUsageService,
  recordZcodeSuccess,
  sessionsService,
} from '@/modules/providers/index.js';
import { captureJobCheckpoint, runGitCommand } from '@/modules/worktrees/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';
import type { JobTokenUsage, LLMProvider, ZcodeProbeOptions, ZcodeProbeResult } from '@/shared/types.js';

import { cleanupJob } from './cleanup.service.js';
import { getEffectOutbox, readEffectPayload } from './effect-outbox.service.js';
import type { EffectOutbox, EffectReplayHandler } from './effect-outbox.service.js';
import { detectGlmQuotaReset, getGlmQuotaReset, recordGlmQuotaReset } from './glm-quota.service.js';
import { appendHubEvent } from './hub-events.service.js';
import {
  armLimitRecovery,
  classifyTurnFailure,
  dueLimitAction,
  LIMIT_CONTINUE_PROMPT,
  nextAuthProbe,
  readLimitRecovery,
} from './usage-recovery.service.js';
import type { LimitRecovery, TurnFailure } from './usage-recovery.service.js';
import { isInGlmPeakHours, pickBackend } from './balancer.service.js';
import { modelLabel, resolveRequestedModel } from './orchestrator-config.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';
import { prepareJobProjectMap } from './project-map.service.js';
import {
  hasCommitsAhead,
  getCheckLogPath,
  isDirty,
  isGitRepository,
  listGitRepositories,
  prepareWorktree,
  resolveBaseBranch,
  resolveMainCheckout,
} from './workspace.service.js';

/** Jobs that hold a backend's slot: being set up, or with an agent on them (working or waiting for an answer). */
const SLOT_STATES = ['preparing', 'active'] as const;

const BACKENDS: OrchestratorBackend[] = ['claude', 'codex', 'glm', 'agy', 'zcode'];

/** What a job looks like to its callers: the row, plus what its session is doing right now. */

/** Job branches are `feature/…` or `bugfix/…`; a finished one waits for the hub's review before it reaches main. */
export type OrchestratorJobKind = 'feature' | 'bugfix';
export const JOB_KINDS: readonly OrchestratorJobKind[] = ['feature', 'bugfix'];
export type OrchestratorJobView = OrchestratorJobRow & {
  /** working while its session has a turn going, waiting when the agent stopped for an answer. */
  activity: 'working' | 'waiting' | null;
  /** CLI job line: this job moved from GLM after quota exhaustion. */
  quotaFallback: boolean;
  /** `tjob show`: each CI/CD queue step, when it began and how long it took (so far, for the current one). */
  mergeSteps: OrchestratorMergeStepTiming[];
  /** `tjob show`: full output of the latest merge check, retained outside the worktree. */
  checkLogPath: string | null;
  /** `tjob ls`: the job waits on its provider (usage limit or login); resumesAt is null when only the hub can resume it. */
  limitWait: { failureClass: 'usage_limit' | 'auth_required'; resumesAt: string | null; waitsForHub: boolean } | null;
  /** Token usage and notional API cost calculated from session transcript. */
  usage: JobTokenUsage | null;
};

export type OrchestratorMergeStepTiming = OrchestratorMergeStepEvent & { durationMs: number | null };

/** Steps with nothing after them: their duration is not counted. */
const RESTING_MERGE_STEPS = new Set<string>(['none', 'review', 'merged', 'blocked']);

/**
 * Used by the job view: a step lasts until the next one began; the job's current step until now, unless it is a
 * resting one (merged, blocked...), which has no duration.
 */
export function mergeStepTimings(history: OrchestratorMergeStepEvent[], nowMs: number): OrchestratorMergeStepTiming[] {
  return history.map((event, index) => {
    const next = history[index + 1];
    const end = next ? Date.parse(next.at) : (RESTING_MERGE_STEPS.has(event.step) ? Number.NaN : nowMs);
    const duration = end - Date.parse(event.at);
    return { ...event, durationMs: Number.isFinite(duration) ? Math.max(0, duration) : null };
  });
}

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

// buildJobPrompt: used by orchestrator jobs and evals/harness to assemble live prompt text.
export function buildJobPrompt(
  job: OrchestratorJobRow,
  label: string,
  projectMapGuidance: string,
  continuation = false,
  repoGuidance = '',
): string {
  return [
    `You are ${label}, working on job ${job.id} — "${job.title}".`,
    `You are in your own git worktree (${job.worktree_path}), on branch ${job.branch}, made from origin/${job.base_branch} of ${job.repo_path}.`,
    '',
    job.prompt.trim(),
    ...(continuation ? ['', 'Another model started this job and stopped at its quota; read `git log`, `git status` and the diff, then continue from where it stopped.'] : []),
    ...(projectMapGuidance ? ['', projectMapGuidance] : []),
    '',
    'How this job works:',
    "- Follow the repository's AGENTS.md / CLAUDE.md. Shared memory (decisions, context) is in Mem0 through the tripam-reasoning MCP when you have it.",
    '- Commit your work on this branch with a descriptive, topic-led message. Never push, never use --no-verify, never touch secrets, k8s, CI or tunnels.',
    '- If you need a decision from the person, ask it and end your turn: they answer in this session. Being stopped mid-turn is not the end of the job: a change of direction or more context is coming.',
    `- Only when the person tells you they do not want this job anymore, run: tjob cancel ${job.id} (and tjob resume ${job.id} if they want it back later).`,
    // The person, 2026-11-04: "a tjob should never run tests on things he didnt touched".
    "- Test only what you changed: the tests of the files, modules, crates or packages your diff touches, plus their direct dependents only when you changed a public interface. Never run the whole test suite or the project's merge gate yourself: the CI/CD queue runs the gate once after tjob done, and CI runs everything after the merge.",
    `- When the code is complete and committed, and the tests of what you changed pass, run: tjob done ${job.id}`,
    `  That hands the branch to the orchestrating session for review; once approved it goes to the CI/CD queue (rebase onto ${job.base_branch}, checks, push, deploy). If anything fails there, you get a message here.`,
    ...(repoGuidance ? ['', `For this repository (${path.basename(job.repo_path)}):`, ...repoGuidance.split('\n').map((line) => `- ${line}`)] : []),
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
  /** The clock GLM's peak hours are read from; tests pin it. */
  now?: () => Date;
  /** Optional preparation is injectable so lifecycle tests can hold it before a job becomes active. */
  prepareProjectMap?: (worktreePath: string) => Promise<string>;
  /** The login check a job waiting with auth_required probes (at most every 10 min); tests stub it. */
  probeAuth?: (provider: LLMProvider) => Promise<boolean>;
  /** Probe ZCode login before dispatching a GLM/zcode turn; tests stub it. */
  probeZcode?: (options?: ZcodeProbeOptions) => Promise<ZcodeProbeResult>;
  /** The durable effect outbox; tests give each simulated server process its own. */
  outbox?: EffectOutbox;
  /** The per-turn checkpoint capture; tests inject a failing one to prove a failed snapshot never fails the turn. */
  captureCheckpoint?: (job: { jobId: string; worktreePath: string }) => Promise<unknown>;
}) {
  const now = deps.now ?? (() => new Date());
  const captureCheckpoint = deps.captureCheckpoint ?? ((job: { jobId: string; worktreePath: string }) => captureJobCheckpoint(job, { runGit: runGitCommand }));
  const outbox = deps.outbox ?? getEffectOutbox();
  // start_turn rows whose turn promise this process holds; the others (re-attached after a restart) close on completion.
  const liveTurnKeys = new Set<string>();
  const prepareProjectMap = deps.prepareProjectMap ?? prepareJobProjectMap;
  const defaultProbeZcode = process.env.NODE_ENV === 'test'
    ? async () => ({ ok: true } as const)
    : probeZcodeLogin;
  const probeZcode = deps.probeZcode ?? defaultProbeZcode;
  const probeAuth = deps.probeAuth ?? (async (provider: LLMProvider) => {
    try {
      if (provider === 'zcode') {
        const probe = await probeZcode({ now: now() });
        return probe.ok;
      }
      return (await providerAuthService.getProviderAuthStatus(provider)).authenticated;
    } catch {
      return false;
    }
  });
  // A job is set up once at a time; a tick that finds it mid-preparation leaves it.
  const preparing = new Set<string>();
  const cleaning = new Set<string>();
  const cleanupAttempted = new Set<string>();
  // In-flight per-turn checkpoints; `afterCheckpoints` lets lifecycle tests wait
  // until the worktrees they remove are no longer being snapshotted.
  const pendingCheckpoints = new Set<Promise<unknown>>();

  function loads(): Record<OrchestratorBackend, number> {
    const counts: Record<OrchestratorBackend, number> = { claude: 0, codex: 0, glm: 0, agy: 0, zcode: 0 };
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
    const model = job.model ?? (session as { model?: string | null } | null)?.model ?? null;
    return {
      ...job,
      quotaFallback: job.backend === 'agy' && Boolean(job.last_error?.startsWith('GLM quota-exhausted')),
      activity: job.state === 'active' ? (processing ? 'working' : 'waiting') : null,
      mergeSteps: mergeStepTimings(readMergeStepHistory(job), now().getTime()),
      checkLogPath: existsSync(getCheckLogPath(job.worktree_path)) ? getCheckLogPath(job.worktree_path) : null,
      model,
      limitWait: limitWait(job),
      usage: job.session_id ? providerTokenUsageService.getJobTokenUsage(job.session_id, model) : null,
    };
  }

  function limitWait(job: OrchestratorJobRow): OrchestratorJobView['limitWait'] {
    const recovery = readLimitRecovery(job.limit_recovery);
    if (!job.failure_class || !recovery || recovery.delivered) return null;
    return {
      failureClass: job.failure_class,
      resumesAt: recovery.gaveUp || recovery.kind === 'auth_required' ? null : recovery.dueAt,
      waitsForHub: recovery.gaveUp,
    };
  }

  function saveRecovery(jobId: string, recovery: LimitRecovery): void {
    orchestratorJobsDb.update(jobId, {
      failure_class: recovery.kind,
      resume_at: recovery.gaveUp || recovery.kind === 'auth_required' ? null : recovery.dueAt,
      limit_recovery: JSON.stringify(recovery),
    });
  }

  /**
   * A failed turn hit its provider's usage limit or needs a login: arm a recovery on the same
   * session instead of failing. True when the failure was handled that way.
   */
  function handleLimitFailure(job: OrchestratorJobRow, appSessionId: string, exitCode: number): boolean {
    const run = chatRunRegistry.getRun(appSessionId);
    const events = run?.events ?? [];
    // Only the provider's own error events (with Claude's SDK error code), never assistant prose or tool output.
    const signals = events.filter((event) => event.kind === 'error').map((event) => ({
      message: String(event.content ?? ''),
      code: typeof event.errorCode === 'string' ? event.errorCode : null,
    }));
    if (!job.backend || signals.length === 0) return false;
    const failure = classifyTurnFailure(job.backend, signals, now());
    if (failure.failureClass === 'other') return false;
    const previous = readLimitRecovery(job.limit_recovery);
    const result = armLimitRecovery({
      jobId: job.id,
      turnId: String(run?.startedAt ?? now().getTime()),
      failure: { ...failure, failureClass: failure.failureClass },
      previous,
      now: now(),
    });
    orchestratorJobsDb.update(job.id, { in_turn: 0, last_error: `${failure.failureClass}: ${failure.reason || `exit code ${exitCode}`}` });
    if (result.status === 'unchanged') return true;
    saveRecovery(job.id, result.recovery);
    const login = failure.failureClass === 'auth_required';
    // One hub wake per login wait, and when recovery is refused or exhausted; an armed usage-limit resume is silent.
    if (result.status !== 'armed' || (login && previous?.kind !== 'auth_required')) {
      appendHubEvent({
        jobId: job.id,
        state: 'waiting',
        title: job.title,
        reason: result.status === 'armed'
          ? `login needed for ${job.backend}; resumes when its login check passes (${failure.reason})`
          : `${login ? 'login needed' : 'usage limit'}, ${result.status === 'refused' ? 'stated reset already past' : 'recovery exhausted'}; waiting for the hub (${failure.reason})`,
      });
    }
    return true;
  }

  /**
   * Holds a job in auth_required when a dispatch probe discovers a failed login before starting a turn.
   * Emits one hub-wake event for a new login wait; subsequent ticks probe at most every 10 min.
   */
  function holdForAuthRequired(job: OrchestratorJobRow, reason: string): void {
    const failure: TurnFailure = { failureClass: 'auth_required', resetAt: null, reason };
    const previous = readLimitRecovery(job.limit_recovery);
    const result = armLimitRecovery({
      jobId: job.id,
      turnId: String(now().getTime()),
      failure: { ...failure, failureClass: 'auth_required' },
      previous,
      now: now(),
    });
    orchestratorJobsDb.update(job.id, { in_turn: 0, last_error: `auth_required: ${reason}` });
    if (result.status === 'unchanged') return;
    saveRecovery(job.id, result.recovery);
    const login = true;
    if (result.status !== 'armed' || (login && previous?.kind !== 'auth_required')) {
      appendHubEvent({
        jobId: job.id,
        state: 'waiting',
        title: job.title,
        reason: result.status === 'armed'
          ? `login needed for ${job.backend}; resumes when its login check passes (${reason})`
          : `login needed, ${result.status === 'refused' ? 'stated reset already past' : 'recovery exhausted'}; waiting for the hub (${reason})`,
      });
    }
  }

  /** Tick: delivers due recoveries (continue turn) and probes logins, at most once per due time. */
  async function sweepLimitRecoveries(): Promise<void> {
    for (const job of orchestratorJobsDb.listByState(['active'])) {
      const recovery = readLimitRecovery(job.limit_recovery);
      const action = dueLimitAction(recovery, now());
      if (!recovery || action === 'none' || !job.session_id || !job.backend) continue;
      if (chatRunRegistry.isProcessing(job.session_id)) continue;
      if (action === 'expire') {
        saveRecovery(job.id, { ...recovery, gaveUp: true });
        appendHubEvent({ jobId: job.id, state: 'waiting', title: job.title, reason: `${recovery.kind === 'auth_required' ? 'login wait' : 'usage-limit recovery'} past 24 h since the first failure; waiting for the hub` });
        continue;
      }
      if (action === 'probe') {
        // Re-arm before the probe so a slow check is not run twice by overlapping ticks.
        saveRecovery(job.id, nextAuthProbe(recovery, now()));
        if (!await probeAuth(deps.config().backends[job.backend].provider)) continue;
      }
      // Recorded in the outbox before anything is sent: a restart replays it once, a second tick finds it done.
      const key = `resume:limit:${job.id}:${recovery.key}:${recovery.attempt}:${recovery.dueAt}`;
      const sent = await outbox.run(
        { key, jobId: job.id, kind: 'recovery_resume', replay: 'safe', payload: { content: LIMIT_CONTINUE_PROMPT, limitRecovery: true } },
        async () => {
          saveRecovery(job.id, { ...recovery, delivered: true });
          return sendTurn(orchestratorJobsDb.get(job.id) as OrchestratorJobRow, LIMIT_CONTINUE_PROMPT, key);
        },
      );
      if (sent.status === 'skipped' && sent.reason === 'done') saveRecovery(job.id, { ...recovery, delivered: true });
    }
  }

  const RESTART_PROMPT = 'The CLI server restarted while you were working. Check the state of the worktree (git status, git log) and continue where you left off.';

  /** Replays a resume the old process recorded: sent once, unless its turn already started. */
  const replayResume: EffectReplayHandler = async (row, payload) => {
    if (!row.job_id) return;
    if (orchestratorEffectsDb.listByJob(row.job_id, 'start_turn').some((turn) => readEffectPayload(turn).resumeKey === row.key)) return;
    const job = orchestratorJobsDb.get(row.job_id);
    if (!job || job.state !== 'active' || !job.session_id || chatRunRegistry.isProcessing(job.session_id)) return;
    if (payload.limitRecovery) {
      const recovery = readLimitRecovery(job.limit_recovery);
      if (recovery) saveRecovery(job.id, { ...recovery, delivered: true });
    }
    if (!await sendTurn(job, String(payload.content ?? RESTART_PROMPT), row.key)) throw new Error('the resume turn did not start');
  };

  /** Stops a job's turn wherever it runs (this process, its detached unit, the provider). */
  async function abortSession(sessionId: string, provider: LLMProvider | null): Promise<void> {
    const run = chatRunRegistry.getRun(sessionId);
    if (run?.status === 'running') {
      run.abortController.abort();
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
    }
    abortTurn(sessionId);
    if (provider) await deps.runtime.abort(provider, sessionId);
  }

  const replayAbort: EffectReplayHandler = async (_row, payload) => {
    await abortSession(String(payload.sessionId), (payload.provider as LLMProvider | null) ?? null);
  };

  /** A cleanup the old process left half-done: done again, unless the job was resumed meanwhile. */
  const replayCleanup: EffectReplayHandler = async (row) => {
    const job = row.job_id ? orchestratorJobsDb.get(row.job_id) : null;
    if (!job || (job.state !== 'cancelled' && job.merge_step !== 'merged')) return;
    const outcome = await cleanupJob(job, deps.config(), false);
    if (outcome.status.startsWith('worktree removal failed')) throw new Error(outcome.status);
  };

  /** Starts a turn in the job's session. False when the session is busy or gone. */
  async function sendTurn(job: OrchestratorJobRow, content: string, resumeKey: string | null = null): Promise<boolean> {
    if (!job.session_id || !job.backend || orchestratorJobsDb.get(job.id)?.state === 'cancelled') return false;
    const backend = deps.config().backends[job.backend];

    if (job.backend === 'glm' || job.backend === 'zcode' || backend.provider === 'zcode') {
      const probe = await probeZcode({ now: now() });
      if (!probe.ok && probe.error === 'login_failed') {
        holdForAuthRequired(job, probe.message);
        return false;
      }
    }

    // Recorded before the turn starts; process-bound: a restart never starts it again (recover() decides).
    const turnKey = `turn:${job.id}:${randomUUID()}`;
    const begun = outbox.begin({ key: turnKey, jobId: job.id, kind: 'start_turn', replay: 'process_bound', payload: { sessionId: job.session_id, resumeKey } });
    if (begun.status === 'skipped') {
      // A failed abort or cleanup of this job: no new turn before the old work is undone.
      orchestratorJobsDb.update(job.id, { last_error: `No new turn: ${begun.row.kind} ${begun.row.key} failed (${begun.row.last_error ?? 'unknown'}); it must be undone first` });
      return false;
    }
    liveTurnKeys.add(turnKey);
    orchestratorJobsDb.update(job.id, { in_turn: 1 });
    const turn = runDetachedChatTurn({
      sessionId: job.session_id,
      userId: firstUserId(),
      content,
      options: {
        // The job's own model (Flash or full GLM...), whatever the config's default is now.
        model: job.model ?? backend.model,
        ...(backend.effort ? { effort: backend.effort } : {}),
        permissionMode: 'bypassPermissions',
      },
    }, { runtime: deps.runtime });
    void turn.then(
      (result) => outbox.finish(turnKey, result.started ? { ok: true } : { ok: false, error: 'the turn never started' }),
      (error: unknown) => outbox.finish(turnKey, { ok: false, error: String(error) }),
    ).finally(() => liveTurnKeys.delete(turnKey));
    // Settles when the turn ends; only a turn that never started is reported here.
    const started = await Promise.race([
      turn.then((result) => result.started),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
    ]);
    if (!started) orchestratorJobsDb.update(job.id, { in_turn: 0 });
    return started;
  }

  function effectHandlers(): Partial<Record<OrchestratorEffectRow['kind'], EffectReplayHandler>> {
    return { recovery_resume: replayResume, abort_turn: replayAbort, cleanup: replayCleanup };
  }

  /** Gives a queued (or half-prepared) job its backend, worktree and session, then starts its first turn. */
  async function start(job: OrchestratorJobRow, backend: OrchestratorBackend): Promise<void> {
    const config = deps.config();
    const backendConfig = config.backends[backend];
    // The model asked for, when the backend that took the job offers it (a
    // requested backend at its cap sends the job to GLM, on GLM's default).
    const offered = job.model !== null && (job.model === backendConfig.model || job.model in backendConfig.models);
    const model = offered ? job.model as string : backendConfig.model;
    const label = modelLabel(backendConfig, model);
    preparing.add(job.id);
    const continuation = Boolean(job.session_id && job.last_error?.startsWith('GLM quota-exhausted'));
    const quotaFallback = backend === 'agy' && (continuation || ((job.requested_backend === 'glm' || job.requested_backend === 'zcode') && getGlmQuotaReset(now())));
    orchestratorJobsDb.update(job.id, { backend, model, state: 'preparing', last_error: quotaFallback ? job.last_error ?? 'GLM quota-exhausted; using agy' : null });
    try {
      await prepareWorktree({
        repoPath: job.repo_path,
        worktreePath: job.worktree_path,
        branch: job.branch,
        baseBranch: job.base_branch,
      });
      const projectMapGuidance = await prepareProjectMap(job.worktree_path);

      if (orchestratorJobsDb.get(job.id)?.state !== 'preparing') return;
      let sessionId = job.session_id;
      if (sessionId && sessionsDb.getSessionById(sessionId)?.provider !== backendConfig.provider) sessionId = null;
      if (!sessionId) {
        projectsDb.createProjectPath(job.worktree_path, `${path.basename(job.repo_path)} · ${job.title}`);
        sessionId = sessionsService.createAppSession(backendConfig.provider, job.worktree_path, job.title).sessionId;
        sessionsDb.updateSessionCustomName(sessionId, `${label} · ${job.title}`);
        sessionsDb.setSessionModel(sessionId, model);
        if (backendConfig.effort) sessionsDb.setSessionEffort(sessionId, backendConfig.effort);
      }
      const ready = orchestratorJobsDb.update(job.id, { session_id: sessionId, state: 'active' }) as OrchestratorJobRow;
      const repoGuidance = deps.config().jobGuidance[path.basename(ready.repo_path)] ?? '';
      await sendTurn(ready, buildJobPrompt(ready, label, projectMapGuidance, continuation, repoGuidance));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Job ${job.id} could not start`, message);
      if (orchestratorJobsDb.get(job.id)?.state === 'preparing') orchestratorJobsDb.update(job.id, { state: 'failed', last_error: message });
    } finally {
      preparing.delete(job.id);
    }
  }

  return {
    loads,

    /** Routes and CLI display the backend cooldown independently of job errors. */
    backendStatus(): { glm: string | null; zcode: string | null } {
      const status = getGlmQuotaReset(now());
      return { glm: status, zcode: status };
    },

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
      /** A model id the backend offers (`zai-coding-plan/glm-5.3` or `glm-5.3`); with no backend, it picks one. */
      model?: string | null;
      baseBranch: string | null;
      /** The branch family: `feature/<slug>-<id>` (default) or `bugfix/<slug>-<id>`; the hub reviews it before main. */
      kind?: OrchestratorJobKind;
    }): Promise<OrchestratorJobView> {
      const config = deps.config();
      const requested = input.model ? resolveRequestedModel(config, input.backend, input.model) : null;
      const repoPath = path.resolve(input.repoPath);
      if (!repoPath.startsWith(path.resolve(config.workspacesRoot) + path.sep)) {
        throw new AppError(`repo must be inside ${config.workspacesRoot}`, { code: 'REPO_OUTSIDE_WORKSPACES', statusCode: 400 });
      }
      // An unusable repository is refused here with a reason, not discovered
      // later as a failed `git fetch` in an already recorded job.
      if (!existsSync(repoPath)) {
        throw new AppError(`repo ${repoPath} does not exist`, { code: 'REPO_NOT_FOUND', statusCode: 400 });
      }
      if (!await isGitRepository(repoPath)) {
        throw new AppError(`${repoPath} is not a git repository`, { code: 'NOT_A_REPOSITORY', statusCode: 400 });
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
        requestedBackend: requested?.backend ?? input.backend,
        model: requested?.model ?? null,
        branch: `${input.kind ?? 'feature'}/${slugify(input.title)}-${id}`,
        worktreePath: path.join(config.worktreesRoot, repoName, id),
      });
      await this.tick();
      return view(orchestratorJobsDb.get(job.id) ?? job);
    },

    /**
     * "To load balancer" from a session whose folder is not itself in a git
     * repository (a workspace holding many repositories): what the picker
     * needs. The session's own repository — null here — would go first, then
     * the repositories of recent jobs, then the rest as `listGitRepositories`
     * sorted them.
     */
    async fromSessionContext(input: { sessionId: string }): Promise<{
      /** The main checkout the session's folder works in; null when it is in no repository. */
      sessionRepoPath: string | null;
      workspaceRoot: string;
      repos: Array<{ name: string; path: string }>;
    }> {
      const session = sessionsDb.getSessionById(input.sessionId) as { project_path?: string | null } | null;
      if (!session?.project_path) {
        throw new AppError(`Session ${input.sessionId} was not found`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      const config = deps.config();
      const sessionRepoPath = await resolveMainCheckout(session.project_path);
      const recents = this.recentRepoPaths();
      const rank = (repo: { path: string }): number =>
        repo.path === sessionRepoPath ? -1 : recents.indexOf(repo.path) === -1 ? recents.length : recents.indexOf(repo.path);
      const repos = (await listGitRepositories(config.workspacesRoot))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      return { sessionRepoPath, workspaceRoot: config.workspacesRoot, repos };
    },

    /** Repositories of recorded jobs, most recently used first; the picker lists them ahead of the others. */
    recentRepoPaths(): string[] {
      const seen: string[] = [];
      for (const job of [...orchestratorJobsDb.list()].reverse()) {
        if (!seen.includes(job.repo_path)) seen.push(job.repo_path);
      }
      return seen;
    },

    /**
     * "Send to load balancer" from a session's composer or queue: the message
     * becomes a job in the repository the session works in (its main
     * checkout), instead of waiting for that session. When the session's
     * folder is in no repository, the client picks one (`repo`, as
     * `tjob new --repo`); with neither, a clear refusal.
     */
    async createFromSession(input: {
      sessionId: string;
      content: string;
      backend: OrchestratorBackend | null;
      /** The repository picked in the client when the session's folder is not in one. */
      repo?: string | null;
    }): Promise<OrchestratorJobView> {
      const session = sessionsDb.getSessionById(input.sessionId) as { project_path?: string | null; custom_name?: string | null } | null;
      if (!session?.project_path) {
        throw new AppError(`Session ${input.sessionId} was not found`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      const repoPath = await resolveMainCheckout(session.project_path)
        ?? (input.repo?.trim() ? path.resolve(input.repo.trim()) : null);
      if (!repoPath) {
        throw new AppError(
          `${session.project_path} is not inside a git repository: pick the repository this job is for`,
          { code: 'PICK_A_REPOSITORY', statusCode: 400 },
        );
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
      if (orchestratorJobsDb.get(id)?.state !== job.state) {
        throw new AppError(`Job ${id} is no longer active`, { code: 'JOB_NOT_ACTIVE', statusCode: 409 });
      }
      const mergeStep = deps.config().review ? 'review' : 'queued';
      orchestratorJobsDb.update(id, { state: 'done', merge_step: mergeStep, merge_attempts: 0,
                                       pushed_sha: null, last_error: null });
      if (mergeStep === 'review') {
        appendHubEvent({ jobId: job.id, state: 'review', title: job.title, reason: 'waiting for review' });
      }
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /**
     * `tjob approve <id>`: the orchestrating session (the hub) reviewed a finished job's branch; it joins the CI/CD
     * queue. Only a job waiting at review can be approved.
     */
    async approve(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      if (job.state !== 'done' || job.merge_step !== 'review') {
        throw new AppError(`Job ${id} is ${job.state} (${job.merge_step}), not waiting for review`, { code: 'JOB_NOT_IN_REVIEW', statusCode: 409 });
      }
      orchestratorJobsDb.update(id, { merge_step: 'queued' });
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /**
     * `tjob cancel`: the person said they do not want the job anymore (in
     * its session, where its agent runs this, or from a shell). It frees its
     * slot and leaves the CI/CD queue; branch and session are kept; a clean worktree is removed after the session stops.
     * A merge already past its rebase is not taken back.
     */
    async cancel(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      if (['rebase', 'check', 'push', 'deploy', 'merged'].includes(job.merge_step)) {
        throw new AppError(`Job ${id} is already in the CI/CD queue (${job.merge_step})`, { code: 'JOB_MERGING', statusCode: 409 });
      }
      orchestratorJobsDb.update(id, { state: 'cancelled', merge_step: 'none', in_turn: 0 });
      if (job.session_id) {
        const sessionId = job.session_id;
        const provider = (sessionsDb.getSessionById(sessionId)?.provider as LLMProvider | undefined) ?? null;
        // An undo: replayed after a restart, and while it is failed the job starts no new turn.
        await outbox.run(
          { key: `abort:${id}:${sessionId}:${now().toISOString()}`, jobId: id, kind: 'abort_turn', replay: 'safe', blocking: true, payload: { sessionId, provider } },
          () => abortSession(sessionId, provider),
        ).catch((error: unknown) => console.warn(`[Orchestrator] Abort of job ${id} failed; its new turns wait for it`, error));
      }
      await this.tick();
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /** `tjob resume`: a cancelled job takes a slot again; a failed one is set up again. */
    async resume(id: string): Promise<OrchestratorJobView> {
      const job = orchestratorJobsDb.get(id);
      if (!job) throw new AppError(`Job ${id} was not found`, { code: 'JOB_NOT_FOUND', statusCode: 404 });
      if (cleaning.has(id)) throw new AppError(`Job ${id} is being cleaned`, { code: 'JOB_CLEANING', statusCode: 409 });
      const blocker = outbox.blockingFailure(id);
      if (blocker && !await outbox.retry(blocker, effectHandlers()[blocker.kind])) {
        const failed = orchestratorEffectsDb.get(blocker.key);
        throw new AppError(`Job ${id} cannot resume: its ${blocker.kind} failed (${failed?.last_error ?? 'unknown'}) and must be undone first`, { code: 'JOB_UNDO_FAILED', statusCode: 409 });
      }
      cleanupAttempted.delete(id);
      if (job.state === 'cancelled' && !existsSync(job.worktree_path)) orchestratorJobsDb.update(id, { state: 'queued' });
      else if (job.state === 'cancelled') orchestratorJobsDb.update(id, { state: job.session_id ? 'active' : 'queued' });
      if (job.state === 'failed') orchestratorJobsDb.update(id, { state: 'queued', last_error: null });
      await this.tick();
      return view(orchestratorJobsDb.get(id) as OrchestratorJobRow);
    },

    /** Routes and the balancer use this to clean finished jobs after their sessions stop. */
    async sweepCleanup(dryRun = false, automatic = false): Promise<Array<{ id: string; status: string }>> {
      const results: Array<{ id: string; status: string }> = [];
      for (const job of orchestratorJobsDb.list()) {
        if (job.state !== 'cancelled' && job.merge_step !== 'merged') continue;
        if (cleaning.has(job.id) || preparing.has(job.id) || this.isSessionBusy(job)) {
          results.push({ id: job.id, status: 'session busy; kept' });
          continue;
        }
        if (automatic && cleanupAttempted.has(job.id)) continue;
        cleaning.add(job.id);
        try {
          const current = orchestratorJobsDb.get(job.id);
          if (!current || (current.state !== 'cancelled' && current.merge_step !== 'merged')) continue;
          if (dryRun) {
            results.push(await cleanupJob(current, deps.config(), true));
            continue;
          }
          // The automatic sweep's key is per finish (state and time), so a restart does not clean the same job twice.
          const key = automatic
            ? `cleanup:${current.id}:${current.state === 'cancelled' ? 'cancelled' : 'merged'}:${current.updated_at}`
            : `cleanup:${current.id}:manual:${now().toISOString()}`;
          const ran = await outbox.run({ key, jobId: current.id, kind: 'cleanup', replay: 'safe', blocking: true }, async () => {
            const result = await cleanupJob(current, deps.config(), false);
            if (result.status.startsWith('worktree removal failed')) throw new Error(result.status);
            return result;
          });
          const outcome = ran.status === 'ran' ? ran.value : { id: current.id, status: ran.reason === 'done' ? 'cleaned before a restart' : 'cleanup in progress' };
          results.push(outcome);
          if (!dryRun) {
            cleanupAttempted.add(job.id);
            if (outcome.status !== 'cleaned') console.warn(`[Orchestrator] Cleanup ${job.id}: ${outcome.status}`);
          }
        } catch (error) {
          results.push({ id: job.id, status: `cleanup failed: ${String(error)}` });
          console.warn(`[Orchestrator] Cleanup ${job.id} failed`, error);
        } finally { cleaning.delete(job.id); }
      }
      return results;
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

    /** Lifecycle tests await this so they remove job worktrees only after in-flight checkpoints finished. */
    async afterCheckpoints(): Promise<void> {
      await Promise.allSettled([...pendingCheckpoints]);
    },

    /**
     * A turn ended, finished or stopped: either way the job keeps its slot. A
     * stop is a change of direction or more context coming, not the end of
     * the job; that takes the person saying so (`tjob cancel`).
     */
    handleRunCompleted(completion: { appSessionId: string; exitCode: number; aborted: boolean }): void {
      const job = orchestratorJobsDb.getBySessionId(completion.appSessionId);
      if (!job) return;
      // A turn re-attached after a restart has no promise here: its start_turn row closes now.
      for (const row of orchestratorEffectsDb.listByJob(job.id, 'start_turn')) {
        if (row.state === 'running' && !liveTurnKeys.has(row.key)) outbox.finish(row.key, { ok: true, note: 'turn ended (re-attached)' });
      }
      // One checkpoint per ended turn (T3 Code-style): snapshot the worktree as the
      // agent left it, so `tjob rollback` can restore any earlier turn. Recorded in the
      // outbox (non-blocking, process-bound) and fire-and-forget: a failed snapshot
      // never fails or blocks the job's turn or its state handling.
      const turnKey = outbox.latest(job.id, 'start_turn')?.key ?? `ended@${now().toISOString()}`;
      let capture: Promise<unknown>;
      try {
        capture = outbox.run(
          { key: `checkpoint:${turnKey}`, jobId: job.id, kind: 'checkpoint', replay: 'process_bound' },
          () => captureCheckpoint({ jobId: job.id, worktreePath: job.worktree_path }),
        );
      } catch (error) {
        capture = Promise.reject(error);
      }
      pendingCheckpoints.add(capture);
      void capture
        .finally(() => pendingCheckpoints.delete(capture))
        .catch((error) => console.warn(`[Orchestrator] Checkpoint ${job.id} failed`, error));
      if ((job.backend === 'glm' || job.backend === 'zcode') && !completion.aborted && job.state === 'active') {
        const errors = chatRunRegistry.getRun(completion.appSessionId)?.events
          .filter((event) => event.kind === 'error').map((event) => String(event.content ?? '')).join('\n') ?? '';
        const until = detectGlmQuotaReset(errors, now());
        if (until) {
          recordGlmQuotaReset(until);
          // Queue the existing branch. A backend change creates a new session,
          // keeping the stopped GLM transcript available for inspection.
          orchestratorJobsDb.update(job.id, { state: 'queued', in_turn: 0, last_error: `GLM quota-exhausted until ${until.toISOString()}` });
          return;
        }
      }
      // Not gated on the exit code: Claude ends a turn that hit its limit with exit code 0 and an error event.
      if (!completion.aborted && job.state === 'active' && handleLimitFailure(job, completion.appSessionId, completion.exitCode)) return;
      if (!completion.aborted && completion.exitCode === 0) {
        if (job.backend && (job.backend === 'glm' || job.backend === 'zcode' || deps.config().backends[job.backend]?.provider === 'zcode')) {
          recordZcodeSuccess(now());
        }
      }
      orchestratorJobsDb.update(job.id, {
        in_turn: 0,
        // A turn that did not stop on a limit or login ends the streak.
        ...(job.limit_recovery && !completion.aborted ? { failure_class: null, resume_at: null, limit_recovery: null } : {}),
        ...(completion.exitCode !== 0 && !completion.aborted ? { last_error: `The last turn ended with exit code ${completion.exitCode}` } : {}),
      });
      if (job.state === 'active') {
        appendHubEvent({
          jobId: job.id,
          state: 'turn_ended',
          title: job.title,
          reason: completion.exitCode === 0
            ? 'turn ended without tjob done'
            : (completion.aborted ? 'turn was aborted' : `turn ended with exit code ${completion.exitCode}`),
        });
      }
    },

    /**
     * One pass of the balancer: follows what sessions are doing, then gives
     * queued jobs a backend while there is room, oldest first.
     */
    async tick(): Promise<void> {
      await this.sweepCleanup(false, true);
      for (const job of orchestratorJobsDb.listByState(['active', 'done'])) {
        if (!job.session_id || !chatRunRegistry.isProcessing(job.session_id)) continue;
        if (job.state === 'done' && (job.merge_step === 'queued' || job.merge_step === 'review') && startedAfter(job.session_id, job.updated_at)) {
          // A new turn after `tjob done` (not the turn that called it), before
          // the queue took the branch: the work is not finished after all.
          orchestratorJobsDb.update(job.id, { state: 'active', merge_step: 'none', in_turn: 1 });
        } else if (job.state === 'active' && !job.in_turn) orchestratorJobsDb.update(job.id, { in_turn: 1 });
      }

      await sweepLimitRecoveries();

      const config = deps.config();
      const peak = config.glmPeakHours.avoid && isInGlmPeakHours(config.glmPeakHours, now());
      const avoid: OrchestratorBackend[] = peak ? ['glm', 'zcode'] : [];
      const quota = { glmExhausted: Boolean(getGlmQuotaReset(now())), fallback: config.glmQuotaFallback };
      for (const job of orchestratorJobsDb.listByState(['queued'])) {
        const continuation = Boolean(job.session_id && job.last_error?.startsWith('GLM quota-exhausted'));
        const requested = continuation ? (config.glmQuotaFallback === 'agy' ? 'agy' : (job.requested_backend ?? 'glm')) : job.requested_backend;
        const backend = pickBackend(requested, loads(), caps(config), config.fallbackBackend, avoid, quota);
        // A planned handoff waits for agy rather than overflowing back to GLM.
        if (!backend || (continuation && config.glmQuotaFallback === 'agy' && backend !== 'agy')) continue;
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
        // A resume replayed from the outbox already started a turn in this process.
        if (outbox.runningHere(job.id, 'start_turn').some((row) => liveTurnKeys.has(row.key) && readEffectPayload(row).resumeKey)) continue;
        // One continue per interrupted turn: keyed by the turn the restart cut, so a second restart, a second
        // call or the usage-limit tick never sends it twice; the next cut turn gets its own.
        const anchor = outbox.latest(job.id, 'start_turn')?.key ?? `in_turn@${job.updated_at}`;
        const key = `resume:restart:${job.id}:${anchor}`;
        await outbox.run(
          { key, jobId: job.id, kind: 'recovery_resume', replay: 'safe', payload: { content: RESTART_PROMPT } },
          () => sendTurn(job, RESTART_PROMPT, key),
        );
      }
    },

    /** Startup: replay handlers for the safe effects this service records. */
    effectHandlers,

    /** Startup: a start_turn row whose turn re-attached (its session is processing again) is kept, not dropped. */
    adoptEffect(row: OrchestratorEffectRow): boolean {
      if (row.kind !== 'start_turn') return false;
      const sessionId = readEffectPayload(row).sessionId;
      return typeof sessionId === 'string' && chatRunRegistry.isProcessing(sessionId);
    },
  };
}

/** The jobs service's API, for the CI/CD queue and the routes. */
export type JobsService = ReturnType<typeof createJobsService>;
