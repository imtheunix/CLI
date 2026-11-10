import path from 'node:path';

import { orchestratorJobsDb } from '@/modules/database/index.js';
import type { OrchestratorJobRow, OrchestratorReviewDefect, OrchestratorReviewRisk } from '@/modules/database/index.js';

import { appendHubEvent } from './hub-events.service.js';
import { MAX_REFUTE_TIMEOUT_MS } from './orchestrator-config.service.js';
import type { OrchestratorConfig, ReviewConfig } from './orchestrator-config.service.js';
import { selectRefuteBackend } from './refute.service.js';
import type { RefuteService } from './refute.service.js';
import { runReviewGate } from './review-gate.service.js';
import { isDirty, revParse, runCommand, tail } from './workspace.service.js';

/** The branch measurements used by risk policy and hub notifications, never the patch itself. */
export type ReviewDiff = { files: string[]; lines: number; stat: string; hasBinary: boolean };

type ReviewJobs = {
  approve(id: string): Promise<unknown>;
  reopenWithMessage(job: OrchestratorJobRow, message: string): Promise<boolean>;
  isSessionBusy(job: OrchestratorJobRow): boolean;
};
type GateRunner = typeof runReviewGate;

/** Valid repo-relative paths and path-like brief tokens that cannot safely constrain a diff. */
export function parseBriefPaths(prompt: string): { paths: string[]; unsafe: string[] } {
  const paths = new Set<string>();
  const unsafe = new Set<string>();
  const tokens = prompt.match(/`[^`\n]+`|(?:^|[\s("'])((?:\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s)"',;:.])/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^[`\s("']+|[`)\]"',;:.]+$/g, '').replace(/^\.\//, '');
    if (!token || token.includes('://')) continue;
    if (!token.includes('/') && !/\.[A-Za-z0-9]+$/.test(token)) continue;
    if (token.startsWith('/') || token.split('/').includes('..') || /\s/.test(token)) unsafe.add(token);
    else paths.add(token);
  }
  return { paths: [...paths], unsafe: [...unsafe] };
}

/** Review policy/tests: extracts repo-relative paths explicitly named in the job brief. */
export function briefPaths(prompt: string): string[] {
  return parseBriefPaths(prompt).paths;
}

/** Review service/tests: all low-risk predicates fail closed and return human-readable escalation reasons. */
export function evaluateReviewRisk(
  job: OrchestratorJobRow,
  diff: ReviewDiff,
  config: ReviewConfig,
): { risk: OrchestratorReviewRisk; reasons: string[] } {
  const reasons: string[] = [];
  if (diff.lines >= config.maxLines) reasons.push(`${diff.lines} changed lines (limit < ${config.maxLines})`);
  if (diff.hasBinary) reasons.push('binary diff size cannot be verified');
  const risky = config.riskyPaths.map((entry) => entry.replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean);
  const riskyFiles = diff.files.filter((file) => file.split('/').some((segment) => risky.includes(segment.toLowerCase())));
  if (riskyFiles.length > 0) reasons.push(`risky paths: ${riskyFiles.join(', ')}`);
  const repoName = path.basename(job.repo_path);
  if (config.protectedRepos.includes(repoName) || config.protectedRepos.includes(job.repo_path)) reasons.push('protected production-deploy repository');
  const brief = parseBriefPaths(job.prompt);
  if (brief.unsafe.length > 0) reasons.push(`unsafe or ambiguous brief paths: ${brief.unsafe.join(', ')}`);
  if (brief.paths.length > 0) {
    const outside = diff.files.filter((file) => !brief.paths.some((candidate) => {
      if (candidate.endsWith('/')) return file.startsWith(candidate);
      if (candidate.includes('/')) return file === candidate || file.startsWith(`${candidate}/`);
      return file === candidate || file.endsWith(`/${candidate}`);
    }));
    if (outside.length > 0) reasons.push(`outside the brief's paths: ${outside.join(', ')}`);
  }
  return { risk: reasons.length === 0 ? 'low' : 'high', reasons };
}

function formatDefects(defects: OrchestratorReviewDefect[]): string {
  return defects.map((defect, index) => [
    `${index + 1}. ${defect.what}`,
    `Probe: ${defect.probe}`,
    `Output:\n${tail(defect.output, 40).slice(0, 4_000)}`,
  ].join('\n')).join('\n\n');
}

/**
 * Orchestrator module: advances durable gate/refute/policy steps after `tjob done`.
 * A restart simply re-enters the persisted step; a re-attached refute session is awaited, not duplicated.
 */
export function createReviewService(deps: {
  jobs: ReviewJobs;
  config: () => OrchestratorConfig;
  refuteService: RefuteService;
  gate?: GateRunner;
  run?: typeof runCommand;
}) {
  const run = deps.run ?? runCommand;
  const gate = deps.gate ?? runReviewGate;
  const refute = deps.refuteService;
  const inFlight = new Set<string>();
  const runningRefutes = new Set<string>();

  async function git(worktree: string, args: string[]): Promise<string> {
    const result = await run('git', args, { cwd: worktree });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${tail(result.stderr, 10)}`);
    return result.stdout.trim();
  }

  async function diff(job: OrchestratorJobRow): Promise<ReviewDiff> {
    const range = `origin/${job.base_branch}...HEAD`;
    const [names, numstat, stat] = await Promise.all([
      git(job.worktree_path, ['diff', '--name-only', range]),
      git(job.worktree_path, ['diff', '--numstat', range]),
      git(job.worktree_path, ['diff', '--stat', range]),
    ]);
    let lines = 0;
    let hasBinary = false;
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, deleted] = line.split('\t');
      if (added === '-' || deleted === '-') hasBinary = true;
      else lines += Number(added) + Number(deleted);
    }
    return { files: names.split('\n').filter(Boolean), lines, stat, hasBinary };
  }

  function current(job: OrchestratorJobRow, head?: string): OrchestratorJobRow | null {
    const latest = orchestratorJobsDb.get(job.id);
    if (!latest || latest.state !== 'done' || latest.merge_step !== 'review') return null;
    if (head && latest.review_head_sha !== head) return null;
    return latest;
  }

  async function needsHub(job: OrchestratorJobRow, reason: string): Promise<void> {
    orchestratorJobsDb.update(job.id, { review_step: 'hub', review_risk: 'high', last_error: reason.split('\n')[0].slice(0, 300) });
    appendHubEvent({ jobId: job.id, state: 'review', title: job.title, reason: `review needed: ${reason}` });
  }

  async function fixOrEscalate(
    job: OrchestratorJobRow,
    failure: { kind: 'gate' | 'defects'; message: string; stat: string; verdict?: 'defects' },
  ): Promise<void> {
    const latest = current(job);
    if (!latest) return;
    const summary = `${failure.kind === 'gate' ? 'gate red' : 'refutation found defects'}: ${failure.message}\n${failure.stat}`;
    if (latest.review_round === 0) {
      const reopened = orchestratorJobsDb.update(job.id, {
        review_step: 'fix',
        review_round: 1,
        ...(failure.verdict ? { review_verdict: failure.verdict } : {}),
        last_error: null,
      }) as OrchestratorJobRow;
      const delivered = await deps.jobs.reopenWithMessage(reopened, [
        `Automatic review (${failure.kind === 'gate' ? 'touched-file gate' : 'refutation'}) found problems:`,
        failure.message,
        'Fix only these reproduced problems, commit, run the focused checks, and run tjob done again. This is the one automatic fix round.',
      ].join('\n\n'));
      if (delivered) return;
      const undelivered = orchestratorJobsDb.get(job.id);
      const canPark = current(job)
        || (undelivered?.state === 'active' && undelivered.merge_step === 'none');
      if (!canPark) return; // a concurrent cancel/approve owns the job now
      const parked = orchestratorJobsDb.update(job.id, { state: 'done', merge_step: 'review' }) as OrchestratorJobRow;
      await needsHub(parked, `${summary}\nThe producer did not receive the only automatic fix message (session busy or authentication hold); inspect the evidence above.`);
      return;
    }
    await needsHub(latest, summary);
  }

  async function stepGate(job: OrchestratorJobRow): Promise<void> {
    const head = await revParse(job.worktree_path, 'HEAD');
    if (!head) throw new Error('Cannot resolve HEAD for the review gate');
    if (job.review_head_sha !== head) {
      job = orchestratorJobsDb.update(job.id, { review_head_sha: head, review_session_id: null, review_verdict: null, review_risk: null }) as OrchestratorJobRow;
    }
    const branchDiff = await diff(job);
    const result = await gate(job, branchDiff.files, deps.config().checks, run);
    const latest = current(job, head);
    if (!latest) return;
    if (!result.ok) {
      await fixOrEscalate(latest, {
        kind: 'gate',
        message: `\`${result.command}\` failed. Last <= 40 lines:\n\`\`\`\n${tail(result.output, 40)}\n\`\`\`\nFull log: ${result.logPath}`,
        stat: branchDiff.stat,
      });
      return;
    }
    if (await isDirty(job.worktree_path)) {
      await fixOrEscalate(latest, { kind: 'gate', message: 'The gate left the worktree dirty.', stat: branchDiff.stat });
      return;
    }
    orchestratorJobsDb.update(job.id, { review_step: 'refute', last_error: null });
  }

  async function stepRefute(job: OrchestratorJobRow): Promise<void> {
    const reviewConfig = deps.config().review;
    const cap = Math.max(1, reviewConfig.refuteCap);
    if (runningRefutes.size >= cap) return;
    runningRefutes.add(job.id);
    const timeoutMs = Math.min(MAX_REFUTE_TIMEOUT_MS, Math.max(1, reviewConfig.refuteTimeoutMs ?? MAX_REFUTE_TIMEOUT_MS));
    const abortController = new AbortController();
    let reviewSessionId = job.review_session_id;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        try {
          refute.abort?.(job, reviewSessionId);
        } catch (error) {
          console.warn(`[Review] Refutation cleanup failed for ${job.id}`, error);
        }
        reject(new Error(`Refutation timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const backend = selectRefuteBackend(job, deps.config());
      const verdict = await Promise.race([refute.refute(job, backend, reviewSessionId, (sessionId) => {
        reviewSessionId = sessionId;
        if (current(job, job.review_head_sha ?? undefined)) orchestratorJobsDb.update(job.id, { review_session_id: sessionId });
      }, { signal: abortController.signal }), timeout]);
      if (timedOut) throw new Error(`Refutation timed out after ${timeoutMs} ms`);
      const latest = current(job, job.review_head_sha ?? undefined);
      if (!latest) return;
      if (await isDirty(job.worktree_path)) {
        await needsHub(latest, 'the read-only refutation left the worktree dirty; gate green');
        return;
      }
      const branchDiff = await diff(latest);
      if (verdict.verdict === 'defects') {
        orchestratorJobsDb.update(job.id, { review_verdict: 'defects' });
        await fixOrEscalate(latest, { kind: 'defects', message: formatDefects(verdict.defects), stat: branchDiff.stat, verdict: 'defects' });
        return;
      }
      orchestratorJobsDb.update(job.id, { review_step: 'policy', review_verdict: 'pass', last_error: null });
    } catch (error) {
      if (!timedOut) throw error;
      const latest = current(job, job.review_head_sha ?? undefined);
      if (latest) {
        await needsHub(latest, `automatic refutation timed out after ${timeoutMs} ms; reviewer aborted and its session was archived; gate green`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      runningRefutes.delete(job.id);
    }
  }

  async function stepPolicy(job: OrchestratorJobRow): Promise<void> {
    const branchDiff = await diff(job);
    const decision = evaluateReviewRisk(job, branchDiff, deps.config().review);
    const latest = current(job, job.review_head_sha ?? undefined);
    if (!latest) return;
    if (decision.risk === 'high') {
      await needsHub(latest, `gate green; refute pass; ${decision.reasons.join('; ')}\n${branchDiff.stat}`);
      return;
    }
    orchestratorJobsDb.update(job.id, { review_step: 'approved', review_risk: 'low', last_error: null });
    // Deliberately the same approval path as `tjob approve`; the merge queue sees no special case.
    await deps.jobs.approve(job.id);
    appendHubEvent({ jobId: job.id, state: 'review_fyi', title: job.title, reason: `auto-approved; gate green; refute pass\n${branchDiff.stat}` });
  }

  async function advance(job: OrchestratorJobRow): Promise<void> {
    if (deps.jobs.isSessionBusy(job)) return; // never inspect or run probes in a worktree the producer is still using
    if (job.review_step === 'gate') return stepGate(job);
    if (job.review_step === 'refute') return stepRefute(job);
    if (job.review_step === 'policy') return stepPolicy(job);
  }

  return {
    /** One pass; different jobs advance concurrently, with only refutations bounded by their independent cap. */
    tick(): Promise<void> {
      if (!deps.config().review.enabled) return Promise.resolve();
      const advancing: Array<Promise<void>> = [];
      for (const job of orchestratorJobsDb.listByState(['done'])) {
        if (job.merge_step !== 'review' || !['gate', 'refute', 'policy'].includes(job.review_step) || inFlight.has(job.id)) continue;
        inFlight.add(job.id);
        advancing.push(advance(job).catch(async (error: unknown) => {
          const latest = current(job);
          if (latest) await needsHub(latest, `automatic review could not finish: ${error instanceof Error ? error.message : String(error)}; inspect the branch and run tjob approve when safe`);
        }).finally(() => inFlight.delete(job.id)));
      }
      return Promise.all(advancing).then(() => undefined);
    },
  };
}

/** Review service API used by the orchestrator module. */
export type ReviewService = ReturnType<typeof createReviewService>;
