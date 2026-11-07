// Restart-safe action record: idea from T3 Code's EffectOutbox / ProviderRuntimeRecoveryService (MIT), reimplemented.
import { randomUUID } from 'node:crypto';

import { orchestratorEffectsDb } from '@/modules/database/index.js';
import type {
  OrchestratorEffectKind,
  OrchestratorEffectReplay,
  OrchestratorEffectRow,
} from '@/modules/database/index.js';

export type EffectSpec = {
  /** Idempotency key: the same effect asked for twice (a restart, a second tick, a second caller) has the same key. */
  key: string;
  jobId: string | null;
  kind: OrchestratorEffectKind;
  replay: OrchestratorEffectReplay;
  /** An undo (abort, cleanup): while it is failed, the job's other effects are refused. */
  blocking?: boolean;
  payload?: Record<string, unknown>;
};

/** Where a crash can cut an effect; tests inject a crash at each one. */
export type EffectBoundary = 'before_write' | 'after_write' | 'during_run' | 'after_run';

export type EffectSkip = { status: 'skipped'; reason: 'done' | 'in_flight' | 'blocked'; row: OrchestratorEffectRow };
export type EffectBegin = { status: 'begun'; row: OrchestratorEffectRow } | EffectSkip;
export type EffectRun<T> = { status: 'ran'; value: T } | EffectSkip;

/** Startup: replays a safe effect cut short by the restart; must be idempotent (it may have run, fully or in part). */
export type EffectReplayHandler = (row: OrchestratorEffectRow, payload: Record<string, unknown>) => Promise<void>;

export type EffectRecoveryReport = { replayed: string[]; adopted: string[]; dropped: string[]; failed: string[]; held: string[] };

/** Thrown by a test's boundary hook: the process "dies" there, so nothing after it is written. */
export class SimulatedCrash extends Error {
  constructor(boundary: EffectBoundary) {
    super(`simulated crash ${boundary}`);
    this.name = 'SimulatedCrash';
  }
}

/** A failed undo is retried at startup at most this many times in all; then it waits for a person. */
const MAX_BLOCKING_ATTEMPTS = 5;
/** Finished rows are kept this long (the record of what ran), then pruned at startup. */
const RETENTION_MS = 14 * 24 * 3_600_000;
/** Effects a failed undo of the same job refuses: anything that would start new work on it. */
const GATED_KINDS = new Set<OrchestratorEffectKind>(['start_turn', 'recovery_resume', 'merge_check', 'push']);

export function readEffectPayload(row: OrchestratorEffectRow): Record<string, unknown> {
  try {
    return row.payload ? JSON.parse(row.payload) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * The orchestrator's durable effect outbox. Every side effect is written here (pending) before it runs, then
 * marked running (attempt + 1), then done or failed. A row's boot id says which server process ran it: after a
 * restart, `recover` replays the safe rows the old process left pending or running, adopts or drops the
 * process-bound ones with a reason, and retries failed undos.
 */
export function createEffectOutbox(options: { bootId?: string; boundary?: (boundary: EffectBoundary, key: string) => void } = {}) {
  const bootId = options.bootId ?? randomUUID();
  const hit = (boundary: EffectBoundary, key: string) => options.boundary?.(boundary, key);

  function blockingFailure(jobId: string | null): OrchestratorEffectRow | null {
    if (!jobId) return null;
    return orchestratorEffectsDb.listByJob(jobId).find((row) => row.blocking === 1 && row.state === 'failed') ?? null;
  }

  /** The per-job barrier, for live and replayed effects alike: a failed undo of the job holds its new work. */
  function barrier(spec: Pick<EffectSpec, 'key' | 'jobId' | 'kind'>): OrchestratorEffectRow | null {
    const blocker = GATED_KINDS.has(spec.kind) ? blockingFailure(spec.jobId) : null;
    return blocker && blocker.key !== spec.key ? blocker : null;
  }

  function begin(spec: EffectSpec): EffectBegin {
    hit('before_write', spec.key);
    const existing = orchestratorEffectsDb.get(spec.key);
    if (existing?.state === 'done') return { status: 'skipped', reason: 'done', row: existing };
    if (existing && (existing.state === 'pending' || existing.state === 'running') && existing.boot_id === bootId) {
      return { status: 'skipped', reason: 'in_flight', row: existing };
    }
    const blocker = barrier(spec);
    if (blocker) return { status: 'skipped', reason: 'blocked', row: blocker };
    if (!existing) {
      orchestratorEffectsDb.insert({
        key: spec.key,
        job_id: spec.jobId,
        kind: spec.kind,
        replay: spec.replay,
        state: 'pending',
        blocking: spec.blocking ? 1 : 0,
        attempts: 0,
        payload: spec.payload ? JSON.stringify(spec.payload) : null,
        boot_id: bootId,
        last_error: null,
      });
    } else {
      orchestratorEffectsDb.update(spec.key, { state: 'pending', boot_id: bootId, ...(spec.payload ? { payload: JSON.stringify(spec.payload) } : {}) });
    }
    hit('after_write', spec.key);
    const row = orchestratorEffectsDb.update(spec.key, {
      state: 'running',
      attempts: (existing?.attempts ?? 0) + 1,
      boot_id: bootId,
    }) as OrchestratorEffectRow;
    return { status: 'begun', row };
  }

  function finish(key: string, outcome: { ok: true; note?: string } | { ok: false; error: string }): void {
    const row = orchestratorEffectsDb.get(key);
    if (!row || row.state === 'done' || row.state === 'dropped') return;
    orchestratorEffectsDb.update(key, outcome.ok
      ? { state: 'done', last_error: outcome.note ?? null }
      : { state: 'failed', last_error: outcome.error });
  }

  async function run<T>(spec: EffectSpec, effect: () => Promise<T>): Promise<EffectRun<T>> {
    const begun = begin(spec);
    if (begun.status === 'skipped') return begun;
    let value: T;
    try {
      const running = effect();
      try {
        // The effect has started (up to its first await) when this boundary is hit.
        hit('during_run', spec.key);
      } catch (crash) {
        running.catch(() => undefined);
        throw crash;
      }
      value = await running;
      hit('after_run', spec.key);
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      finish(spec.key, { ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    finish(spec.key, { ok: true });
    return { status: 'ran', value };
  }

  return {
    bootId,
    begin,
    finish,
    run,
    blockingFailure,

    /** Rows of this process still running (a turn started here and not yet ended). */
    runningHere(jobId: string, kind: OrchestratorEffectKind): OrchestratorEffectRow[] {
      return orchestratorEffectsDb.listByJob(jobId, kind).filter((row) => row.state === 'running' && row.boot_id === bootId);
    },

    /** Closes every running row of a job's kind (a turn ended, whichever process started it). */
    finishRunning(jobId: string, kind: OrchestratorEffectKind, outcome: { ok: true; note?: string } | { ok: false; error: string }): void {
      for (const row of orchestratorEffectsDb.listByJob(jobId, kind)) {
        if (row.state === 'running' || row.state === 'pending') finish(row.key, outcome);
      }
    },

    latest(jobId: string, kind: OrchestratorEffectKind): OrchestratorEffectRow | null {
      return orchestratorEffectsDb.listByJob(jobId, kind).at(-1) ?? null;
    },

    /** Retries one failed undo now (`tjob resume`); true once it is done. */
    async retry(row: OrchestratorEffectRow, handler: EffectReplayHandler | undefined): Promise<boolean> {
      if (!handler) return false;
      const begun = begin({ key: row.key, jobId: row.job_id, kind: row.kind, replay: row.replay, blocking: row.blocking === 1 });
      if (begun.status === 'skipped') return begun.reason === 'done';
      try {
        await handler(begun.row, readEffectPayload(begun.row));
        finish(row.key, { ok: true, note: 'retried' });
        return true;
      } catch (error) {
        finish(row.key, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },

    /**
     * Startup, after detached turns re-attached and before anything new runs. Rows another process left
     * pending/running: safe ones are replayed by their kind's handler; process-bound ones are adopted when
     * `adopt` says their work is still alive (a re-attached turn), else dropped with the reason. Failed undos
     * are retried, so a job they block gets a chance to go on.
     */
    async recover(handlers: Partial<Record<OrchestratorEffectKind, EffectReplayHandler>>, adopt: (row: OrchestratorEffectRow) => boolean = () => false): Promise<EffectRecoveryReport> {
      const report: EffectRecoveryReport = { replayed: [], adopted: [], dropped: [], failed: [], held: [] };
      orchestratorEffectsDb.prune(new Date(Date.now() - RETENTION_MS).toISOString());
      const unfinished = orchestratorEffectsDb.listByState(['pending', 'running', 'failed'])
        .filter((row) => row.boot_id !== bootId)
        .filter((row) => row.state !== 'failed' || (row.blocking === 1 && row.attempts < MAX_BLOCKING_ATTEMPTS));
      // Undos first: a cleanup or abort the old process left half-done runs before the job's other effects.
      unfinished.sort((a, b) => b.blocking - a.blocking);
      for (const row of unfinished) {
        if (row.replay === 'process_bound') {
          if (adopt(row)) {
            orchestratorEffectsDb.update(row.key, { boot_id: bootId });
            report.adopted.push(row.key);
          } else {
            orchestratorEffectsDb.update(row.key, {
              state: 'dropped',
              last_error: `bound to the previous server process (${row.state} at restart); not replayed`,
            });
            report.dropped.push(row.key);
          }
          continue;
        }
        // Undos ran first, so a job whose undo still failed is known here: its gated rows wait, unfinished
        // and still owned by the old boot, until the undo is done (`tjob resume`, the next tick, the next start).
        const blocker = barrier({ key: row.key, jobId: row.job_id, kind: row.kind });
        if (blocker) {
          orchestratorEffectsDb.update(row.key, { state: 'pending', last_error: `held: undo ${blocker.key} of the job failed` });
          report.held.push(row.key);
          continue;
        }
        const handler = handlers[row.kind];
        if (!handler) {
          orchestratorEffectsDb.update(row.key, { state: 'dropped', last_error: `no replay handler for ${row.kind} (${row.state} at restart)` });
          report.dropped.push(row.key);
          continue;
        }
        orchestratorEffectsDb.update(row.key, { state: 'running', attempts: row.attempts + 1, boot_id: bootId });
        try {
          await handler(row, readEffectPayload(row));
          finish(row.key, { ok: true, note: `replayed after a restart (${row.state})` });
          report.replayed.push(row.key);
        } catch (error) {
          finish(row.key, { ok: false, error: `replay failed: ${error instanceof Error ? error.message : String(error)}` });
          report.failed.push(row.key);
        }
      }
      return report;
    },
  };
}

export type EffectOutbox = ReturnType<typeof createEffectOutbox>;

let processOutbox: EffectOutbox | null = null;

/** This server process's outbox (one boot id per process); services take an injected one in tests. */
export function getEffectOutbox(): EffectOutbox {
  processOutbox ??= createEffectOutbox();
  return processOutbox;
}
