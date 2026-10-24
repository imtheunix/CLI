import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrchestratorBackend } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';

type BackendConfig = {
  /** The CLI provider runtime the session runs on. */
  provider: LLMProvider;
  model: string;
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
};

/** The order a tie between equally loaded backends is broken in: cheapest first. */
export const BACKEND_TIE_ORDER: OrchestratorBackend[] = ['glm', 'codex', 'claude'];

function defaults(): OrchestratorConfig {
  const home = os.homedir();
  const workspacesRoot = process.env.WORKSPACES_ROOT || path.join(home, 'Tribeira');
  return {
    backends: {
      claude: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', cap: 2, label: 'Claude' },
      codex: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', cap: 2, label: 'GPT' },
      glm: { provider: 'opencode', model: 'zai-coding-plan/glm-5.3', effort: null, cap: 3, label: 'GLM' },
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
  return config;
}
