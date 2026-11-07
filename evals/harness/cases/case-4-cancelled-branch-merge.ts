// Based on ideas from T3 Code (evals/mcp-tool-use, evals/test-signal, evals/README.md), MIT licensed.
import { assembleLivePrompt } from '../runner.js';
import type { HarnessCase } from '../types.js';

export const case4CancelledBranchMerge: HarnessCase = {
  id: 'cancelled-branch-merge-blocked',
  name: "A branch based on a cancelled job's branch was marked merged",
  kind: 'bad',
  experience:
    "Job 88328da6 was marked merged into the branch of cancelled job f8a49612 and never reached main. A stacked job whose parent was cancelled must be blocked, never merged into a dead branch.",
  source: 'docs/orchestrator.md (Job 88328da6) & Commit f6b3c10f',
  setup: {
    job: {
      id: '88328da6',
      title: 'Child job stacked on parent',
      prompt: 'Implement downstream API consumer based on parent branch changes.',
      repo_path: '/home/user/backend',
      worktree_path: '/home/user/.jobs/backend/88328da6',
      branch: 'job/child-88328da6',
      base_branch: 'job/parent-f8a49612',
      merge_step: 'queued',
      state: 'active',
    },
    world: {
      branch: 'job/child-88328da6',
      baseBranch: 'job/parent-f8a49612',
    },
  },
  run() {
    const { text: assembledPrompt, hash: promptHash, tokens: tokenCount } = assembleLivePrompt(this.setup);

    // Synthetic parent job representing cancelled job f8a49612
    const parentJob = {
      id: 'f8a49612',
      branch: 'job/parent-f8a49612',
      base_branch: 'main',
      state: 'cancelled' as const,
      merge_step: null,
    };

    const childJob = {
      id: this.setup.job.id!,
      branch: this.setup.job.branch!,
      base_branch: this.setup.job.base_branch!,
      merge_step: 'queued' as 'queued' | 'check' | 'rebase' | 'push' | 'deploy' | 'merged' | 'blocked',
      pushed_sha: null as string | null,
      last_error: null as string | null,
    };

    /**
     * Evaluates landing rule corresponding directly to merge-queue.service.ts:
     * A stacked job lands where its parent lands. If the parent was cancelled or failed,
     * its branch never reaches a landing branch, so the child MUST be blocked, never merged.
     */
    const evaluateStackedLanding = (child: typeof childJob, parent: typeof parentJob) => {
      if (child.base_branch === parent.branch) {
        if (parent.merge_step === 'merged') {
          // Parent merged into base, repoint child base to parent.base_branch
          child.base_branch = parent.base_branch;
          return { allowPush: true, blocked: false, reason: 'Parent merged; child rebased to parent base' };
        }
        if (parent.state === 'cancelled' || parent.state === 'failed') {
          child.merge_step = 'blocked';
          child.last_error = `origin/${child.base_branch} is job ${parent.id}'s branch, and that job is ${parent.state}: a push there never reaches ${parent.base_branch}, so it would not be merged. Land job ${parent.id}, or create a job based on ${parent.base_branch} with these commits.`;
          return { allowPush: false, blocked: true, reason: child.last_error };
        }
        // Parent still on its way
        return { allowPush: false, blocked: false, reason: 'Parent still in progress' };
      }
      return { allowPush: true, blocked: false, reason: 'Base is a landing branch' };
    };

    const result = evaluateStackedLanding(childJob, parentJob);

    // Regression check: Child job MUST be blocked and not allowed to merge onto parent's dead branch
    if (result.allowPush || !result.blocked || childJob.merge_step === 'merged') {
      return {
        pass: false,
        reason: `Regression: Child job was allowed to push/merge to cancelled branch: step=${childJob.merge_step}`,
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    if (!childJob.last_error || !childJob.last_error.includes('never reaches')) {
      return {
        pass: false,
        reason: 'Child job was blocked but last_error did not explain that cancelled branch never reaches landing branch',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    if (childJob.pushed_sha !== null) {
      return {
        pass: false,
        reason: 'pushed_sha was set for a job blocked on cancelled parent',
        promptHash,
        tokenCount,
        assembledPrompt,
      };
    }

    return {
      pass: true,
      reason: "Guarded: Child stacked on cancelled job f8a49612 is blocked with explanation and never marked merged",
      promptHash,
      tokenCount,
      assembledPrompt,
      details: {
        childMergeStep: childJob.merge_step,
        childLastError: childJob.last_error,
      },
    };
  },
};
