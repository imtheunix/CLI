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

/** Everything the orchestrator can be tuned with; see `loadOrchestratorConfig`. */
export type OrchestratorConfig = {
  backends: Record<OrchestratorBackend, BackendConfig>;
  /** Where a backend whose cap is reached sends the job instead. */
  fallbackBackend: OrchestratorBackend;
  /** Where job worktrees are created, one folder per job. */
  worktreesRoot: string;
  /** Only repositories under this folder can be given jobs. */
  workspacesRoot: string;
  /** The model that resolves rebase conflicts in the CI/CD queue (through `agy`). */
  conflictResolver: { command: string; model: string };
  /** Per-repository check commands (keyed by the repository folder's name), run before a push. */
  checks: Record<string, string>;
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
};

/** The order a tie between equally loaded backends is broken in: cheapest first. */
export const BACKEND_TIE_ORDER: OrchestratorBackend[] = ['glm', 'codex', 'claude'];

function defaults(): OrchestratorConfig {
  const home = os.homedir();
  const workspacesRoot = process.env.WORKSPACES_ROOT || path.join(home, 'Tribeira');
  return {
    backends: {
      claude: { provider: 'claude', model: 'claude-opus-5-5', models: { 'claude-opus-5-5': 'Claude' }, effort: 'high', cap: 2, label: 'Claude' },
      codex: { provider: 'codex', model: 'gpt-6.1-sol', models: { 'gpt-6.1-sol': 'GPT' }, effort: 'medium', cap: 2, label: 'GPT' },
      // Flash costs about a third of the full model's Coding Plan credits; most jobs do not need more.
      glm: {
        provider: 'opencode',
        model: 'zai-coding-plan/glm-5.3-flash',
        models: { 'zai-coding-plan/glm-5.3-flash': 'GLM Flash', 'zai-coding-plan/glm-5.3': 'GLM' },
        effort: null,
        cap: 3,
        label: 'GLM',
      },
    },
    fallbackBackend: 'glm',
    worktreesRoot: path.join(workspacesRoot, '.jobs'),
    workspacesRoot,
    conflictResolver: { command: 'agy', model: 'gemini-3.8-flash-medium' },
    checks: {
      tribeiracli: 'npm run typecheck && npm run lint && npm test && npm run test:client',
    },
    baseBranches: { tribeira: 'develop' },
    forgejo: {
      apiUrl: 'http://127.0.0.1:3000/api/v1',
      tokenFile: path.join(home, '.config/forgejo/claude-code-ops.token'),
    },
    glmPeakHours: { avoid: true, utcOffsetHours: 8, fromHour: 14, toHour: 18 },
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
  if (typeof override.worktreesRoot === 'string') config.worktreesRoot = override.worktreesRoot;
  config.conflictResolver = { ...config.conflictResolver, ...(override.conflictResolver as object ?? {}) };
  config.checks = { ...config.checks, ...(override.checks as Record<string, string> ?? {}) };
  config.baseBranches = { ...config.baseBranches, ...(override.baseBranches as Record<string, string> ?? {}) };
  config.forgejo = { ...config.forgejo, ...(override.forgejo as object ?? {}) };
  config.glmPeakHours = { ...config.glmPeakHours, ...(override.glmPeakHours as object ?? {}) };
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
  const matches = (id: string) => id === requestedModel || id.slice(id.indexOf('/') + 1) === requestedModel;
  const candidates = requestedBackend ? [requestedBackend] : (Object.keys(config.backends) as OrchestratorBackend[]);
  for (const backend of candidates) {
    const model = allowed(backend).find(matches);
    if (model) return { backend, model };
  }
  const offered = candidates.map((backend) => `${backend}: ${allowed(backend).join(', ')}`).join('; ');
  throw new AppError(`model ${requestedModel} is not offered (${offered})`, { code: 'INVALID_MODEL', statusCode: 400 });
}

