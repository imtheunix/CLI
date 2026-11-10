import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrchestratorBackend } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type BackendConfig = {
  /** The CLI provider runtime the session runs on. */
  provider: LLMProvider;
  /** The model a job runs on when it does not ask for one (`tjob new --model`). */
  model: string;
  /**
   * The models a job may ask for, each with the label its session's name
   * starts with (`GLM Flash · <title>`). The default `model` is always allowed;
   * a model missing here is labelled with `label`.
   */
  models: Record<string, string>;
  effort: string | null;
  /** At most this many of its jobs are active at once. */
  cap: number;
  /** Shown in front of the session's name, so the Sessions tab says who works on what. */
  label: string;
};

/** Configuration consumed by the orchestrator jobs, balancer, and merge queue services. */
export type OrchestratorConfig = {
  backends: Record<OrchestratorBackend, BackendConfig>;
  /** Where a backend whose cap is reached sends the job instead. */
  fallbackBackend: OrchestratorBackend;
  /** Jobs service: continue quota-stopped GLM jobs on agy, or wait for reset. */
  glmQuotaFallback: 'agy' | 'wait';
  /**
   * Jobs service: a Codex job that hits its usage limit continues on GLM Flash (same job, worktree and branch)
   * when a GLM slot is free and the ZCode login probe passes; otherwise, and with 'wait', it waits for the reset.
   * The person, 2026-11-07: "when Terra is out of quota replace it with GLM flash".
   */
  codexQuotaFallback: 'glm-flash' | 'wait';
  /** Run glm jobs on zcode instead of opencode. Default 'opencode'. */
  glmProvider: 'opencode' | 'zcode';
  /** Where job worktrees are created, one folder per job. */
  worktreesRoot: string;
  /** Only repositories under this folder can be given jobs. */
  workspacesRoot: string;
  /** The model that resolves rebase conflicts in the CI/CD queue (through `agy`). */
  conflictResolver: { command: string; model: string };
  /** Per-repository check commands (keyed by the repository folder's name), run before a push: a light gate, not the full suite. */
  checks: Record<string, string>;
  /** Per-repository build directory templates containing {id}. */
  cleanup: { buildDirs: Record<string, string> };
  /**
   * Per-repository lines added to every job prompt (keyed by the repository folder's name), e.g. where heavy
   * work runs (the person, 2026-11-05: a load balancer over the workstation and the VM pool, defined in the
   * job's initial prompt).
   */
  jobGuidance: Record<string, string>;
  /** At most this many merge checks run at once on the workstation; the others wait in `check` for a slot. */
  maxConcurrentChecks: number;
  /** Per-repository deploy waiting, keyed by folder name; absent entries default to true. */
  waitForDeploy: Record<string, boolean>;
  /** Per-repository branch jobs merge into, when it is not origin's default branch. */
  baseBranches: Record<string, string>;
  forgejo: { apiUrl: string; tokenFile: string };
  /**
   * Z.ai charges more for GLM on weekdays from `fromHour` to `toHour` (local
   * time at `utcOffsetHours`, so 14:00-18:00 UTC+8). With `avoid`, a job that
   * did not ask for a backend goes to GLM in that window only when Claude and
   * GPT have no room.
   */
  glmPeakHours: { avoid: boolean; utcOffsetHours: number; fromHour: number; toHour: number };
  /**
   * Hub-and-spoke (the user, 2026-10-27: sub-agents never reach each other or production on their own): a job's
   * `tjob done` parks it at `review`; the orchestrating session (the hub) reads the branch and runs `tjob approve`
   * to hand it to the CI/CD queue. Off, `tjob done` queues it at once.
   */
  review: boolean;
  /**
   * Hub session notification configuration. When present and wake is true,
   * the orchestrator wakes the hub session on job events (reviews, waiting turns,
   * blocked merges, merges, stalls) via chat turns.
   */
  hub?: HubWakeConfig;
};

/** Default bound on an undecided hub wake turn before it is abandoned. */
export const DEFAULT_WAKE_ABANDON_MS = 10 * 60_000;

/** Hub notification configuration options. */
export type HubWakeConfig = {
  sessionId: string;
  wake?: boolean;
  debounceSec?: number;
  stallMin?: number;
  /** A wake turn still undecided after this many ms is abandoned and its events released (default 10 min). */
  wakeAbandonMs?: number;
};

/** Jobs/balancer services: ordinary auto-selection ties, cheapest first. Agy is reserved for quota fallback or explicit requests. */
export const BACKEND_TIE_ORDER: OrchestratorBackend[] = ['glm', 'codex', 'claude', 'morph'];

function defaults(): OrchestratorConfig {
  const home = os.homedir();
  const workspacesRoot = process.env.WORKSPACES_ROOT || path.join(home, 'Tribeira');
  return {
    backends: {
      agy: { provider: 'agy', model: 'gemini-3.8-flash-medium', models: { 'gemini-3.8-flash-medium': 'Gemini Flash' }, effort: 'medium', cap: 4, label: 'Gemini Flash' },
      claude: { provider: 'claude', model: 'claude-opus-5-5', models: { 'claude-opus-5-5': 'Claude' }, effort: 'high', cap: 2, label: 'Claude' },
      codex: { provider: 'codex', model: 'gpt-6.1-sol', models: { 'gpt-6.1-sol': 'GPT' }, effort: 'medium', cap: 2, label: 'GPT' },
      // Flash costs about a third of the full model's Coding Plan credits; most jobs do not need more.
      glm: {
        provider: 'opencode',
        model: 'zai-coding-plan/glm-5.3-flash',
        models: { 'zai-coding-plan/glm-5.3-flash': 'GLM Flash', 'zai-coding-plan/glm-5.3': 'GLM' },
        effort: 'medium',
        cap: 3,
        label: 'GLM',
      },
      // Morph DeepSeek through OpenCode (jobs); Morph Kimi K3.1 is the hub's model.
      morph: {
        provider: 'opencode',
        model: 'morph/morph-dsv41flash',
        models: { 'morph/morph-dsv41flash': 'Morph DeepSeek' },
        effort: 'medium',
        cap: 2,
        label: 'Morph',
      },
      zcode: {
        provider: 'zcode',
        model: 'GLM-5.3-Flash',
        models: { 'GLM-5.3-Flash': 'GLM Flash', 'GLM-5.3': 'GLM' },
        effort: 'medium',
        cap: 3,
        label: 'GLM Flash',
      },
    },
    fallbackBackend: 'glm',
    glmQuotaFallback: 'agy',
    codexQuotaFallback: 'wait',
    glmProvider: 'opencode',
    worktreesRoot: path.join(workspacesRoot, '.jobs'),
    workspacesRoot,
    conflictResolver: { command: 'agy', model: 'gemini-3.8-flash-medium' },
    checks: {
      tribeiracli: 'npm run typecheck && npm run lint',
    },
    cleanup: { buildDirs: {} },
    jobGuidance: {},
    maxConcurrentChecks: 1,
    waitForDeploy: {},
    baseBranches: { tribeira: 'develop' },
    forgejo: {
      apiUrl: 'http://127.0.0.1:3000/api/v1',
      tokenFile: path.join(home, '.config/forgejo/claude-code-ops.token'),
    },
    glmPeakHours: { avoid: true, utcOffsetHours: 8, fromHour: 14, toHour: 18 },
    review: true,
  };
}

/**
 * Used by the Orchestrator's jobs and CI/CD queue services. Reads the defaults
 * above, overlaid with `~/.config/cli/orchestrator.json` when present (caps,
 * models, checks...), so tuning needs no rebuild.
 */
export function loadOrchestratorConfig(file = path.join(os.homedir(), '.config/cli/orchestrator.json')): OrchestratorConfig {
  const config = defaults();
  let override: Record<string, unknown> = {};
  try {
    override = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return config;
  }
  const backends = (override.backends ?? {}) as Partial<Record<OrchestratorBackend, Partial<BackendConfig>>>;
  for (const name of Object.keys(config.backends) as OrchestratorBackend[]) {
    config.backends[name] = { ...config.backends[name], ...(backends[name] ?? {}) };
  }
  if (typeof override.fallbackBackend === 'string' && override.fallbackBackend in config.backends) {
    config.fallbackBackend = override.fallbackBackend as OrchestratorBackend;
  }
  if (override.glmQuotaFallback === 'agy' || override.glmQuotaFallback === 'wait') config.glmQuotaFallback = override.glmQuotaFallback;
  if (override.codexQuotaFallback === 'glm-flash' || override.codexQuotaFallback === 'wait') config.codexQuotaFallback = override.codexQuotaFallback;
  if (override.glmProvider === 'opencode' || override.glmProvider === 'zcode') {
    config.glmProvider = override.glmProvider;
  }
  if (config.glmProvider === 'zcode') {
    config.backends.glm.provider = 'zcode';
    config.backends.glm.model = 'GLM-5.3-Flash';
    config.backends.glm.models = { 'GLM-5.3-Flash': 'GLM Flash', 'GLM-5.3': 'GLM' };
  } else if (config.backends.glm.provider === 'zcode') {
    config.glmProvider = 'zcode';
  }
  if (typeof override.worktreesRoot === 'string') config.worktreesRoot = override.worktreesRoot;
  config.conflictResolver = { ...config.conflictResolver, ...(override.conflictResolver as object ?? {}) };
  config.checks = { ...config.checks, ...(override.checks as Record<string, string> ?? {}) };
  if (override.cleanup && typeof override.cleanup === 'object') {
    const dirs = (override.cleanup as Record<string, unknown>).buildDirs;
    if (dirs && typeof dirs === 'object' && !Array.isArray(dirs)) {
      for (const [repo, template] of Object.entries(dirs)) {
        if (typeof template === 'string' && template.includes('{id}')) config.cleanup.buildDirs[repo] = template;
      }
    }
  }
  if (override.jobGuidance && typeof override.jobGuidance === 'object') {
    for (const [repo, text] of Object.entries(override.jobGuidance as Record<string, unknown>)) {
      if (typeof text === 'string' && text.trim()) config.jobGuidance[repo] = text.trim();
    }
  }
  if (typeof override.maxConcurrentChecks === 'number' && override.maxConcurrentChecks >= 1) {
    config.maxConcurrentChecks = Math.floor(override.maxConcurrentChecks);
  }
  config.waitForDeploy = { ...config.waitForDeploy, ...(override.waitForDeploy as Record<string, boolean> ?? {}) };
  config.baseBranches = { ...config.baseBranches, ...(override.baseBranches as Record<string, string> ?? {}) };
  config.forgejo = { ...config.forgejo, ...(override.forgejo as object ?? {}) };
  config.glmPeakHours = { ...config.glmPeakHours, ...(override.glmPeakHours as object ?? {}) };
  if (typeof override.review === 'boolean') config.review = override.review;
  if (override.hub && typeof override.hub === 'object') {
    const hub = override.hub as Record<string, unknown>;
    if (typeof hub.sessionId === 'string' && hub.sessionId.trim()) {
      config.hub = {
        sessionId: hub.sessionId.trim(),
        wake: typeof hub.wake === 'boolean' ? hub.wake : true,
        debounceSec: typeof hub.debounceSec === 'number' && hub.debounceSec >= 0 ? hub.debounceSec : 90,
        stallMin: typeof hub.stallMin === 'number' && hub.stallMin >= 0 ? hub.stallMin : 30,
        wakeAbandonMs: typeof hub.wakeAbandonMs === 'number' && hub.wakeAbandonMs > 0 ? hub.wakeAbandonMs : DEFAULT_WAKE_ABANDON_MS,
      };
    }
  }
  return config;
}

/** The label a backend's session gets for a model: `GLM Flash`, `GLM`, `Claude`... */
export function modelLabel(backend: BackendConfig, model: string): string {
  return backend.models[model] ?? backend.label;
}

/**
 * Used by the jobs service when a job asks for a model (`tjob new --model`).
 * Takes the full id (`zai-coding-plan/glm-5.3`) or the part after its `/`
 * (`glm-5.3`). With no backend asked for, the model picks it. Throws a 400
 * naming the allowed models when the model is not one of the backend's.
 */
export function resolveRequestedModel(
  config: OrchestratorConfig,
  requestedBackend: OrchestratorBackend | null,
  requestedModel: string,
): { backend: OrchestratorBackend; model: string } {
  const allowed = (name: OrchestratorBackend) => [...new Set([config.backends[name].model, ...Object.keys(config.backends[name].models)])];
  const matches = (id: string) => id.toLowerCase() === requestedModel.toLowerCase() || id.slice(id.indexOf('/') + 1).toLowerCase() === requestedModel.toLowerCase();
  const candidates = requestedBackend ? [requestedBackend] : (Object.keys(config.backends) as OrchestratorBackend[]);
  for (const backend of candidates) {
    const model = allowed(backend).find(matches);
    if (model) return { backend, model };
  }
  const offered = candidates.map((backend) => `${backend}: ${allowed(backend).join(', ')}`).join('; ');
  throw new AppError(`model ${requestedModel} is not offered (${offered})`, { code: 'INVALID_MODEL', statusCode: 400 });
}

