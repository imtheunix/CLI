import { orchestratorJobsDb, sessionsDb } from '@/modules/database/index.js';
import type { OrchestratorBackend, OrchestratorJobRow, OrchestratorReviewDefect } from '@/modules/database/index.js';
import { probeZcodeLogin, recordZcodeSuccess, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

import type { OrchestratorConfig } from './orchestrator-config.service.js';

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
export function parseRefuteVerdict(events: Array<{ kind: string; role?: string | null; content?: unknown; exitCode?: number }>): RefuteVerdict {
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

async function waitForRun(sessionId: string): Promise<void> {
  if (!chatRunRegistry.isProcessing(sessionId)) return;
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    unsubscribe = chatRunRegistry.onRunCompleted((completion) => {
      if (completion.appSessionId !== sessionId) return;
      unsubscribe();
      resolve();
    });
    // Close the completion-between-check-and-subscribe race.
    if (!chatRunRegistry.isProcessing(sessionId)) {
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
}) {
  const runTurn = deps.runTurn ?? runDetachedChatTurn;
  return {
    async refute(
      job: OrchestratorJobRow,
      backendName: OrchestratorBackend,
      existingSessionId: string | null,
      onSession: (sessionId: string) => void,
    ): Promise<RefuteVerdict> {
      const backend = deps.config().backends[backendName];
      if (backend.provider === 'zcode') {
        const probe = await probeZcodeLogin();
        if (!probe.ok) throw new Error(`Refutation backend login failed: ${probe.message}`);
      }
      const sessionId = existingSessionId ?? sessionsService.createAppSession(
        backend.provider,
        job.worktree_path,
        `Refute ${job.id}`,
      ).sessionId;
      onSession(sessionId);
      sessionsDb.updateSessionCustomName(sessionId, `Refute · ${job.title}`);
      sessionsDb.setSessionModel(sessionId, backend.model);

      const existing = chatRunRegistry.getRun(sessionId);
      if (existing?.status === 'running') {
        // A server restart re-attached the original detached reviewer; await it instead of launching a duplicate.
        await waitForRun(sessionId);
      } else if (existing?.status !== 'completed') {
        const head = job.review_head_sha;
        if (!head) throw new Error('Refutation has no reviewed HEAD');
        const result = await runTurn({
          sessionId,
          userId: null,
          content: refutePrompt(job, head),
          options: {
            model: backend.model,
            ...(backend.effort ? { effort: backend.effort } : {}),
            permissionMode: 'plan',
            cwd: job.worktree_path,
          },
        }, { runtime: deps.runtime });
        if (!result.started) throw new Error(result.error ?? 'Refutation did not start');
      }
      const currentJob = orchestratorJobsDb.get(job.id);
      if (!currentJob || currentJob.review_session_id !== sessionId) throw new Error('Refutation was superseded');
      const verdict = parseRefuteVerdict(chatRunRegistry.getRun(sessionId)?.events ?? []);
      if (backend.provider === 'zcode') recordZcodeSuccess(new Date());
      return verdict;
    },
  };
}

/** The orchestrator review service's refutation API. */
export type RefuteService = ReturnType<typeof createRefuteService>;
