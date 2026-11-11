import { orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { runGitCommand } from '@/modules/worktrees/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { appendHubEvent } from './hub-events.service.js';
import { lastJobActivityMs } from './job-activity.service.js';
import type { OrchestratorConfig } from './orchestrator-config.service.js';
import { readLimitRecovery } from './usage-recovery.service.js';

/** The health conditions the orchestrator reports to the hub. */
export type HealthCondition = 'no_commit' | 'overtime' | 'dead_slot';

/** One current health flag, as `tjob status` and the Status view show it. */
export type HealthFlag = {
  condition: HealthCondition;
  /** A short human label, e.g. `no commit 47m`. */
  label: string;
  /** How long the condition has held, in milliseconds. */
  sinceMs: number;
};

/** The HEAD of a job's worktree: its commit and when that commit was made. */
export type WorktreeHead = { sha: string; committedAtMs: number };

/** What a nudge attempt actually did: delivered, refused by a live run, or neither. */
export type NudgeOutcome = { started: boolean; refused: boolean };

/** Dependencies injected into createHealthService. */
export type HealthDependencies = {
  config: () => OrchestratorConfig;
  now?: () => Date;
  /** Reads a worktree's HEAD; defaults to git. Tests inject a fake. */
  readHead?: (worktreePath: string) => Promise<WorktreeHead | null>;
  /** Sends a message into a job's own session; defaults to the jobs service's notify path. */
  sendToJob?: (job: OrchestratorJobRow, message: string) => Promise<boolean | NudgeOutcome>;
};

/** The no-commit nudge: sent once per unchanged HEAD before the hub event. */
export const NO_COMMIT_NUDGE = 'Commit your work in progress now with a descriptive message, then continue';

/** The minimum gap between two hub events for the same job and condition. */
const EVENT_DEBOUNCE_MS = 30 * 60_000;

/** How long after the nudge the hub is told when HEAD still has not moved. */
const NO_COMMIT_EVENT_DELAY_MS = 15 * 60_000;

type JobHealthState = {
  headSha: string | null;
  /** When the current HEAD was committed (or the job started, if later). */
  headSinceMs: number;
  nudgedAtMs: number | null;
  noCommitEventAtMs: number | null;
  overtimeEventAtMs: number | null;
  deadSlotEventAtMs: number | null;
};

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** True while the job's session has a turn going (the same test the stall detector uses). */
function isBusy(job: OrchestratorJobRow): boolean {
  return Boolean(job.session_id && chatRunRegistry.isProcessing(job.session_id)) || Boolean(job.in_turn);
}

/**
 * A job whose last turn failed, or whose recovery gave up and waits for the hub.
 * An armed usage-limit/auth recovery is silent by design: it has a resume
 * scheduled, so it is not holding a slot for the hub to cancel or resume.
 */
function isWaitingForHub(job: OrchestratorJobRow): boolean {
  const recovery = readLimitRecovery(job.limit_recovery);
  if (recovery) return recovery.gaveUp;
  return Boolean(job.last_error);
}

function normalizeNudge(result: boolean | NudgeOutcome): NudgeOutcome {
  return typeof result === 'boolean' ? { started: result, refused: !result } : result;
}

async function defaultReadHead(worktreePath: string): Promise<WorktreeHead | null> {
  try {
    const sha = (await runGitCommand(['rev-parse', '--verify', '--quiet', 'HEAD'], worktreePath)).stdout.trim();
    if (!sha) return null;
    const seconds = Number((await runGitCommand(['log', '-1', '--format=%ct', 'HEAD'], worktreePath)).stdout.trim());
    return { sha, committedAtMs: Number.isFinite(seconds) ? seconds * 1000 : Date.now() };
  } catch {
    return null;
  }
}

/**
 * Used by OrchestratorModule and the status service: watches active jobs for a worktree HEAD that has not moved
 * while the session is busy, for runs past `health.maxRunMin`, and for failed/waiting jobs that keep holding a
 * backend slot. It nudges the job's own session before telling the hub, and emits through the same hub event log
 * the wake service debounces.
 */
export function createHealthService(deps: HealthDependencies) {
  const now = deps.now ?? (() => new Date());
  const readHead = deps.readHead ?? defaultReadHead;
  const sendToJob = deps.sendToJob ?? (async () => false);
  const states = new Map<string, JobHealthState>();
  const lastIdleTurnKey = new Map<string, string>();
  let lastContinuationMs = 0;

  function stateFor(job: OrchestratorJobRow, nowMs: number): JobHealthState {
    let state = states.get(job.id);
    if (!state) {
      const created = parseTimestamp(job.created_at) ?? nowMs;
      state = {
        headSha: null,
        headSinceMs: created,
        nudgedAtMs: null,
        noCommitEventAtMs: null,
        overtimeEventAtMs: null,
        deadSlotEventAtMs: null,
      };
      states.set(job.id, state);
    }
    return state;
  }

  function resetNoCommit(state: JobHealthState, head: WorktreeHead, job: OrchestratorJobRow, nowMs: number): void {
    const created = parseTimestamp(job.created_at) ?? nowMs;
    state.headSha = head.sha;
    state.headSinceMs = Math.min(nowMs, Math.max(head.committedAtMs, created));
    state.nudgedAtMs = null;
    state.noCommitEventAtMs = null;
  }

  /**
   * The row as it is now, but only if it is still the same live job the tick
   * snapshotted. A cancellation, completion or a fresh retry that replaced the
   * row must not receive an event for work it no longer owns.
   */
  function currentLiveJob(job: OrchestratorJobRow, states: OrchestratorJobRow['state'][]): OrchestratorJobRow | null {
    const current = orchestratorJobsDb.get(job.id);
    if (!current) return null;
    if (!states.includes(current.state)) return null;
    if (current.created_at !== job.created_at) return null;
    if (current.session_id !== job.session_id) return null;
    return current;
  }

  function emitNoCommit(job: OrchestratorJobRow, state: JobHealthState, nowMs: number): void {
    const current = currentLiveJob(job, ['active']);
    if (!current) return;
    appendHubEvent({
      jobId: current.id,
      state: 'stalled',
      title: current.title,
      reason: `no commit for ${minutes(nowMs - state.headSinceMs)}m`,
    });
    state.noCommitEventAtMs = nowMs;
  }

  async function checkNoCommit(job: OrchestratorJobRow, state: JobHealthState, nowMs: number, noCommitMs: number): Promise<void> {
    if (!job.worktree_path) return;
    const head = await readHead(job.worktree_path);
    if (!head) return;
    // An injected reader can hand back a non-finite commit time; fail closed
    // instead of turning it into an immediate nudge.
    if (!Number.isFinite(head.committedAtMs)) return;
    if (state.headSha !== head.sha) {
      resetNoCommit(state, head, job, nowMs);
    }
    if (!isBusy(job)) return;
    if (nowMs - state.headSinceMs < noCommitMs) return;
    if (state.noCommitEventAtMs !== null) return;

    if (state.nudgedAtMs === null) {
      const outcome = normalizeNudge(await sendToJob(job, NO_COMMIT_NUDGE));
      if (outcome.started) {
        state.nudgedAtMs = nowMs;
        return;
      }
      // A live run owns the session. A refusal to queue a message is proof
      // of life, not a stalled session: try the idle continuation once it ends.
      if (outcome.refused && !chatRunRegistry.isProcessing(job.session_id ?? '')) emitNoCommit(job, state, nowMs);
      return;
    }
    if (nowMs - state.nudgedAtMs < NO_COMMIT_EVENT_DELAY_MS) return;
    emitNoCommit(job, state, nowMs);
  }

  function checkOvertime(job: OrchestratorJobRow, state: JobHealthState, nowMs: number, maxRunMs: number): void {
    if (job.state !== 'active') return;
    const created = parseTimestamp(job.created_at);
    if (created === null) return;
    const runningMs = nowMs - created;
    if (runningMs < maxRunMs) return;
    // Old is not the same as dead: a run still producing transcript/run activity
    // is healthy, however long it has been going. Only an observably idle run is
    // overdue; a genuinely dead one still alerts here (and in hub-wake).
    if (nowMs - lastJobActivityMs(job, nowMs) < maxRunMs) return;
    if (state.overtimeEventAtMs !== null && nowMs - state.overtimeEventAtMs < EVENT_DEBOUNCE_MS) return;
    const current = currentLiveJob(job, ['active']);
    if (!current) return;
    appendHubEvent({
      jobId: current.id,
      state: 'stalled',
      title: current.title,
      reason: `over ${minutes(maxRunMs)} min: split or stop`,
    });
    state.overtimeEventAtMs = nowMs;
  }

  function checkDeadSlot(job: OrchestratorJobRow, state: JobHealthState, nowMs: number, deadSlotMs: number): void {
    if (job.state !== 'active' && job.state !== 'preparing') return;
    if (isBusy(job)) return;
    if (!isWaitingForHub(job)) return;
    const since = parseTimestamp(job.updated_at);
    if (since === null || nowMs - since < deadSlotMs) return;
    if (state.deadSlotEventAtMs !== null && nowMs - state.deadSlotEventAtMs < EVENT_DEBOUNCE_MS) return;
    const current = currentLiveJob(job, ['active', 'preparing']);
    if (!current) return;
    appendHubEvent({
      jobId: current.id,
      state: 'stalled',
      title: current.title,
      reason: `holding a slot: cancel or resume (${minutes(nowMs - since)}m)`,
    });
    state.deadSlotEventAtMs = nowMs;
  }

  /** The health flags a job has right now, for `tjob status` and the Status view. */
  function flagsFor(job: OrchestratorJobRow, nowMs = now().getTime()): HealthFlag[] {
    const config = deps.config().health;
    if (!config.enabled) return [];
    const state = states.get(job.id);
    const flags: HealthFlag[] = [];
    if (job.state === 'active' && state && isBusy(job)) {
      const sinceMs = nowMs - state.headSinceMs;
      if (sinceMs >= config.noCommitMin * 60_000) {
        flags.push({ condition: 'no_commit', label: `no commit ${minutes(sinceMs)}m`, sinceMs });
      }
    }
    if (job.state === 'active') {
      const created = parseTimestamp(job.created_at);
      const maxRunMs = config.maxRunMin * 60_000;
      if (created !== null && nowMs - created >= maxRunMs && nowMs - lastJobActivityMs(job, nowMs) >= maxRunMs) {
        const sinceMs = nowMs - created;
        flags.push({ condition: 'overtime', label: `over ${minutes(config.maxRunMin)}m`, sinceMs });
      }
    }
    if ((job.state === 'active' || job.state === 'preparing') && !isBusy(job) && isWaitingForHub(job)) {
      const since = parseTimestamp(job.updated_at);
      if (since !== null && nowMs - since >= config.deadSlotMin * 60_000) {
        const sinceMs = nowMs - since;
        flags.push({ condition: 'dead_slot', label: `holding slot ${minutes(sinceMs)}m`, sinceMs });
      }
    }
    return flags;
  }

  /** Re-enter a completed session once per ended turn. A real run is never interrupted. */
  async function continueIdle(): Promise<void> {
    for (const job of orchestratorJobsDb.listByState(['active'])) {
      if (!job.session_id || !job.backend || chatRunRegistry.isProcessing(job.session_id)) continue;
      // An armed limit/login recovery has its own durable retry schedule.
      if (isWaitingForHub(job) || job.resume_at) continue;
      const key = job.updated_at;
      if (lastIdleTurnKey.get(job.id) === key) continue;
      const current = currentLiveJob(job, ['active']);
      if (!current) continue;
      lastIdleTurnKey.set(job.id, key);
      try {
        const result = normalizeNudge(await sendToJob(current,
          'Continue your unfinished job; process completed delegated results, commit progress and call tjob done when complete.'));
        if (!result.started && !result.refused && !chatRunRegistry.isProcessing(current.session_id!)) {
          lastIdleTurnKey.delete(job.id);
          appendHubEvent({ jobId: job.id, state: 'stalled', title: job.title, reason: 'idle session has no active turn' });
        }
      } catch (error) {
        lastIdleTurnKey.delete(job.id);
        console.error(`[Orchestrator] Idle continuation ${job.id} failed`, error);
      }
    }
  }

  return {
    async tick(): Promise<void> {
      const config = deps.config().health;
      if (!config.enabled) return;
      const nowMs = now().getTime();
      if (nowMs - lastContinuationMs >= 5 * 60_000) {
        await continueIdle();
        lastContinuationMs = nowMs;
      }
      const noCommitMs = config.noCommitMin * 60_000;
      const maxRunMs = config.maxRunMin * 60_000;
      const deadSlotMs = config.deadSlotMin * 60_000;

      const jobs = orchestratorJobsDb.list();
      const live = new Set(jobs.map((job) => job.id));
      for (const id of states.keys()) {
        if (!live.has(id)) states.delete(id);
      }

      for (const job of jobs) {
        if (job.state !== 'active' && job.state !== 'preparing') continue;
        const state = stateFor(job, nowMs);
        if (job.state === 'active') {
          await checkNoCommit(job, state, nowMs, noCommitMs);
          checkOvertime(job, state, nowMs, maxRunMs);
        }
        checkDeadSlot(job, state, nowMs, deadSlotMs);
      }
    },

    /** Current flags for every job, keyed by job id. */
    flags(): Map<string, HealthFlag[]> {
      const nowMs = now().getTime();
      const result = new Map<string, HealthFlag[]>();
      for (const job of orchestratorJobsDb.list()) {
        const flags = flagsFor(job, nowMs);
        if (flags.length > 0) result.set(job.id, flags);
      }
      return result;
    },

    flagsFor,
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
