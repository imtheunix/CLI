import { orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow } from '@/modules/database/index.js';
import { runGitCommand } from '@/modules/worktrees/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { appendHubEvent } from './hub-events.service.js';
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

/** Dependencies injected into createHealthService. */
export type HealthDependencies = {
  config: () => OrchestratorConfig;
  now?: () => Date;
  /** Reads a worktree's HEAD; defaults to git. Tests inject a fake. */
  readHead?: (worktreePath: string) => Promise<WorktreeHead | null>;
  /** Sends a message into a job's own session; defaults to the jobs service's notify path. */
  sendToJob?: (job: OrchestratorJobRow, message: string) => Promise<boolean>;
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

/** A job whose last turn failed, or whose recovery gave up and waits for the hub. */
function isWaitingForHub(job: OrchestratorJobRow): boolean {
  if (job.last_error) return true;
  return Boolean(readLimitRecovery(job.limit_recovery)?.gaveUp);
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

  async function checkNoCommit(job: OrchestratorJobRow, state: JobHealthState, nowMs: number, noCommitMs: number): Promise<void> {
    if (!job.worktree_path) return;
    const head = await readHead(job.worktree_path);
    if (!head) return;
    if (state.headSha !== head.sha) {
      resetNoCommit(state, head, job, nowMs);
    }
    if (!isBusy(job)) return;
    if (nowMs - state.headSinceMs < noCommitMs) return;

    if (state.nudgedAtMs === null) {
      const sent = await sendToJob(job, NO_COMMIT_NUDGE);
      if (sent) state.nudgedAtMs = nowMs;
      return;
    }
    if (state.noCommitEventAtMs !== null) return;
    if (nowMs - state.nudgedAtMs < NO_COMMIT_EVENT_DELAY_MS) return;
    appendHubEvent({
      jobId: job.id,
      state: 'stalled',
      title: job.title,
      reason: `no commit for ${minutes(nowMs - state.headSinceMs)}m`,
    });
    state.noCommitEventAtMs = nowMs;
  }

  function checkOvertime(job: OrchestratorJobRow, state: JobHealthState, nowMs: number, maxRunMs: number): void {
    if (job.state !== 'active') return;
    const created = parseTimestamp(job.created_at);
    if (created === null) return;
    const runningMs = nowMs - created;
    if (runningMs < maxRunMs) return;
    if (state.overtimeEventAtMs !== null && nowMs - state.overtimeEventAtMs < EVENT_DEBOUNCE_MS) return;
    appendHubEvent({
      jobId: job.id,
      state: 'stalled',
      title: job.title,
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
    appendHubEvent({
      jobId: job.id,
      state: 'stalled',
      title: job.title,
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
      if (created !== null && nowMs - created >= config.maxRunMin * 60_000) {
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

  return {
    /** One pass over the jobs; called by the orchestrator's tick. */
    async tick(): Promise<void> {
      const config = deps.config().health;
      if (!config.enabled) return;
      const nowMs = now().getTime();
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
