import { orchestratorJobsDb, sessionsDb } from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorJobRow, OrchestratorReviewDefect } from '@/modules/database/index.js';
import { probeZcodeLogin, recordZcodeSuccess, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import type { OrchestratorConfig } from './orchestrator-config.service.js';

type RefuteEvent = { kind: string; role?: string | null; content?: unknown; exitCode?: number };
type RefuteOptions = { signal?: AbortSignal };

/** The exact final response contract: prose, guessed defects and malformed results never count as a review. */
export type RefuteVerdict = { verdict: 'pass' | 'defects'; defects: OrchestratorReviewDefect[] };

function refutePrompt(job: OrchestratorJobRow, head: string): string {
  return [
    `Read-only refutation of job ${job.id} (${job.title}) at commit ${head}.`,
    `Work only in the current worktree. Compare origin/${job.base_branch}...HEAD. Do not edit files, commit, create branches, install anything, or access another job.`,
    'Find defects in this diff and prove every claimed defect with a probe or test run. Only reproduced defects count; do not speculate.',
    `The producer's brief was:\n${job.prompt}`,
    'Reply with JSON only: {"verdict":"pass"|"defects","defects":[{"what":"...","probe":"...","output":"..."}]}. Use pass with an empty defects array when nothing was reproduced. Keep prose outside probe output to at most 150 words.',
  ].join('\n\n');
}

function readJsonObject(text: string): unknown {
  return JSON.parse(text.trim()) as unknown;
}

/** Review service/tests: validates the reviewer's final JSON and drops incomplete, unreproduced defect claims. */
export function parseRefuteVerdict(events: RefuteEvent[]): RefuteVerdict {
  const complete = [...events].reverse().find((event) => event.kind === 'complete');
  if (complete && Number(complete.exitCode ?? 0) !== 0) throw new Error(`Refutation exited with code ${complete.exitCode}`);
  const texts = events.filter((event) => event.kind === 'text' && event.role === 'assistant').map((event) => String(event.content ?? ''));
  const deltas = events.filter((event) => event.kind === 'stream_delta').map((event) => String(event.content ?? ''));
  const text = (texts.length > 0 ? texts : deltas).join('').trim();
  if (!text) throw new Error('Refutation returned no assistant response');
  const parsed = readJsonObject(text) as { verdict?: unknown; defects?: unknown };
  if (parsed.verdict !== 'pass' && parsed.verdict !== 'defects') throw new Error('Refutation verdict must be pass or defects');
  if (!Array.isArray(parsed.defects)) throw new Error('Refutation defects must be an array');
  const defects = parsed.defects.map((entry): OrchestratorReviewDefect => {
    const defect = entry as Partial<OrchestratorReviewDefect> | null;
    if (!defect || !defect.what?.trim() || !defect.probe?.trim() || !defect.output?.trim()) {
      throw new Error('Every refuted defect needs what, probe and reproduced output');
    }
    return { what: defect.what.trim(), probe: defect.probe.trim(), output: defect.output.trim() };
  });
  if (parsed.verdict === 'defects' && defects.length === 0) throw new Error('A defects verdict needs reproduced defects');
  if (parsed.verdict === 'pass' && defects.length > 0) throw new Error('A pass verdict cannot contain defects');
  return { verdict: parsed.verdict, defects };
}

/** Review service: a producer is always refuted by a different configured model family. */
export function selectRefuteBackend(job: OrchestratorJobRow, config: OrchestratorConfig): OrchestratorBackend {
  const producer = job.backend ?? job.requested_backend;
  const configured = producer ? config.review.refuteBackendFor[producer] : undefined;
  if (configured && configured !== producer) return configured;
  return producer === 'glm' || producer === 'zcode' ? 'morph' : 'glm';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Refutation was aborted');
}

async function waitForRun(sessionId: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!chatRunRegistry.isProcessing(sessionId)) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const onAbort = () => {
      unsubscribe();
      reject(new Error('Refutation was aborted'));
    };
    unsubscribe = chatRunRegistry.onRunCompleted((completion) => {
      if (completion.appSessionId !== sessionId) return;
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close completion and cancellation between the initial check and subscribing.
    if (signal?.aborted) onAbort();
    else if (!chatRunRegistry.isProcessing(sessionId)) {
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve();
    }
  });
}

/**
 * Automatic review service: runs one read-only app-session turn in the producer's existing worktree.
 * It creates no orchestrator job, branch or worktree, so none of the producer pool's slots is taken.
 */
export function createRefuteService(deps: {
  runtime: ProviderRuntimeGateway;
  config: () => OrchestratorConfig;
  runTurn?: typeof runDetachedChatTurn;
  /** Restart recovery reads the persisted provider transcript; tests supply a terminal response directly. */
  readHistory?: (sessionId: string) => Promise<RefuteEvent[]>;
}) {
  const runTurn = deps.runTurn ?? runDetachedChatTurn;
  const readHistory = deps.readHistory ?? (async (sessionId: string): Promise<RefuteEvent[]> => {
    const history = await sessionsService.fetchHistory(sessionId, { limit: 50 });
    return history.messages.map(({ kind, role, content }) => ({ kind, role, content }));
  });

  function abortSession(sessionId: string | null): void {
    if (!sessionId) return;
    const run = chatRunRegistry.getRun(sessionId);
    const provider = run?.provider ?? (sessionsDb.getSessionById(sessionId)?.provider as LLMProvider | undefined);
    if (run?.status === 'running') run.abortController.abort();
    try {
      if (provider) {
        void deps.runtime.abort(provider, sessionId).catch((error: unknown) => {
          console.warn(`[Review] Refutation provider abort failed for ${sessionId}`, error);
        });
      }
    } catch (error) {
      console.warn(`[Review] Refutation provider abort failed for ${sessionId}`, error);
    }
    // The reviewer's awaiter is released now even if the provider's graceful interrupt hangs.
    if (run) chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
    sessionsDb.updateSessionIsArchived(sessionId, true);
  }

  return {
    /** Timeout and job cancellation abort the reviewer without waiting for a provider acknowledgement. */
    abort(job: OrchestratorJobRow, sessionId?: string | null): void {
      abortSession(sessionId ?? orchestratorJobsDb.get(job.id)?.review_session_id ?? job.review_session_id);
    },

    async refute(
      job: OrchestratorJobRow,
      backendName: OrchestratorBackend,
      existingSessionId: string | null,
      onSession: (sessionId: string) => void,
      options: RefuteOptions = {},
    ): Promise<RefuteVerdict> {
      const signal = options.signal;
      throwIfAborted(signal);
      const backend = deps.config().backends[backendName];
      if (backend.provider === 'zcode') {
        const probe = await probeZcodeLogin();
        throwIfAborted(signal);
        if (!probe.ok) throw new Error(`Refutation backend login failed: ${probe.message}`);
      }
      throwIfAborted(signal);
      const sessionId = existingSessionId ?? sessionsService.createAppSession(
        backend.provider,
        job.worktree_path,
        `Refute ${job.id}`,
      ).sessionId;
      onSession(sessionId);
      sessionsDb.updateSessionCustomName(sessionId, `Refute · ${job.title}`);
      sessionsDb.setSessionModel(sessionId, backend.model);

      const existing = chatRunRegistry.getRun(sessionId);
      let events: RefuteEvent[] | null = null;
      if (existing?.status === 'running') {
        // A server restart re-attached the original detached reviewer; await it instead of launching a duplicate.
        await waitForRun(sessionId, signal);
      } else if (existing?.status === 'completed') {
        events = existing.events;
      } else if (existingSessionId) {
        // The registry is process-local. A completed review survives in the provider transcript,
        // so a restart consumes that terminal response rather than sending the prompt a second time.
        const persisted = await readHistory(sessionId);
        throwIfAborted(signal);
        if (persisted.length > 0) events = persisted;
      }
      if (!events) {
        throwIfAborted(signal);
        const head = job.review_head_sha;
        if (!head) throw new Error('Refutation has no reviewed HEAD');
        const result = await runTurn({
          sessionId,
          userId: null,
          content: refutePrompt(job, head),
          signal,
          options: {
            model: backend.model,
            ...(backend.effort ? { effort: backend.effort } : {}),
            permissionMode: 'plan',
            cwd: job.worktree_path,
          },
        }, { runtime: deps.runtime });
        if (signal?.aborted) {
          abortSession(sessionId);
          throwIfAborted(signal);
        }
        if (!result.started) throw new Error(result.error ?? 'Refutation did not start');
      }
      throwIfAborted(signal);
      const currentJob = orchestratorJobsDb.get(job.id);
      if (!currentJob || currentJob.state !== 'done' || currentJob.merge_step !== 'review' || currentJob.review_session_id !== sessionId) {
        throw new Error('Refutation was superseded');
      }
      const verdict = parseRefuteVerdict(events ?? chatRunRegistry.getRun(sessionId)?.events ?? []);
      if (backend.provider === 'zcode') recordZcodeSuccess(new Date());
      return verdict;
    },
  };
}

/** The orchestrator review service's refutation API. */
export type RefuteService = ReturnType<typeof createRefuteService>;
