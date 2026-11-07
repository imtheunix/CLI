// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { retireDetachedSessionTurns } from '@/modules/detached-turns/index.js';
import { assembleLivePrompt } from '../runner.js';
import type { HarnessCase } from '../types.js';

export const case3HubResumeReattach: HarnessCase = {
  id: 'hub-resume-reattach-duplicate',
  name: 'Hub resume while the CLI re-attached the same turn (duplicate instance)',
  kind: 'bad',
  experience:
    'A server restart or hub wake occurred while an active turn was re-attached. If the recovery/resume path triggered a new turn while the reattached turn was already processing, two concurrent instances ran on the same session.',
  source: 'docs/orchestrator.md & jobs.service.ts (recover isProcessing guard)',
  setup: {
    job: {
      id: 'job-resume-03',
      title: 'Active job during server restart',
      prompt: 'Refactor background task scheduler.',
      repo_path: '/home/user/backend',
      worktree_path: '/home/user/.jobs/backend/job-resume-03',
      branch: 'feature/task-scheduler-03',
      base_branch: 'main',
      state: 'active',
      in_turn: 1,
      session_id: 'sess-reattach-03',
    },
    continuation: true,
  },
  run() {
    const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);

    const sessionId = this.setup.job.session_id!;
    let turnDispatched = false;

    // Simulate recovery evaluation function that matches jobs.service.ts recover logic:
    // "if (!job.in_turn || !job.session_id || chatRunRegistry.isProcessing(job.session_id)) continue;"
    const evaluateRecoveryDispatch = (job: typeof this.setup.job): boolean => {
      if (!job.in_turn || !job.session_id || chatRunRegistry.isProcessing(job.session_id)) {
        return false;
      }
      return true;
    };

    // Scenario A: The CLI re-attached to the live turn across restart.
    // Register the run in chatRunRegistry as actively processing.
    const activeRun = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'claude',
      providerSessionId: 'provider-sess-03',
      connection: null,
      userId: 1,
    });

    if (!activeRun) {
      return {
        pass: false,
        reason: 'Failed to start initial run in chatRunRegistry',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // Verify chatRunRegistry correctly reports the session is processing
    if (!chatRunRegistry.isProcessing(sessionId)) {
      activeRun.writer.send({ kind: 'complete', exitCode: 1 } as any);
      return {
        pass: false,
        reason: 'chatRunRegistry failed to report reattached run as processing',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // Crucial duplicate check: Attempting to start another run for the same session MUST return null
    const duplicateRun = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'claude',
      providerSessionId: 'provider-sess-03-dup',
      connection: null,
      userId: 1,
    });
    if (duplicateRun !== null) {
      activeRun.writer.send({ kind: 'complete', exitCode: 1 } as any);
      return {
        pass: false,
        reason: 'chatRunRegistry allowed a duplicate concurrent run on the same session',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // Now evaluate whether recovery or hub resume attempts to dispatch a duplicate turn:
    turnDispatched = evaluateRecoveryDispatch(this.setup.job);

    if (turnDispatched) {
      activeRun.writer.send({ kind: 'complete', exitCode: 1 } as any);
      return {
        pass: false,
        reason: 'Duplicate instance triggered: recovery dispatched a turn while reattached turn was still processing',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // Scenario B: Turn completes / unregisters.
    activeRun.writer.send({ kind: 'complete', exitCode: 0 } as any);

    // Now that the turn is no longer processing, recovery is permitted to resume if needed.
    const canResumeAfterFinish = evaluateRecoveryDispatch(this.setup.job);
    if (!canResumeAfterFinish) {
      return {
        pass: false,
        reason: 'Recovery failed to resume turn even when session was idle',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    // Scenario C: Verify retireDetachedSessionTurns hook is functional
    if (typeof retireDetachedSessionTurns !== 'function') {
      return {
        pass: false,
        reason: 'retireDetachedSessionTurns is not a function in detached-turns',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    return {
      pass: true,
      reason: 'Guarded: isProcessing(sessionId) correctly prevents duplicate turn dispatch while reattached turn is active',
      promptHash,
      tokenCount,
      assembledPrompt,
      details: {
        sessionId,
        preventedDuplicateDispatch: !turnDispatched,
      },
    };
  },
};
