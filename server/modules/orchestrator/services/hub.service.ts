import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { OrchestratorConfig } from './orchestrator-config.service.js';

/** What `tjob hub` and the hub routes show about the active hub session. */
export type HubStatus = {
  /** The configured hub's app session id; null when orchestrator.json has none. */
  sessionId: string | null;
  /** Whether hub wake turns are on for this session (the config's default applies). */
  wake: boolean;
  /** The session row's provider/model/effort/agent/name; null fields when unset or the session is gone. */
  provider: string | null;
  model: string | null;
  effort: string | null;
  agent: string | null;
  customName: string | null;
  /** False when the configured hub session no longer exists in the database. */
  exists: boolean;
};

/** What `tjob hub new` creates: a hub-capable app session, without switching the hub to it. */
export type HubSessionCreated = {
  sessionId: string;
  provider: string;
  projectPath: string;
  model: string | null;
  effort: string | null;
  agent: string | null;
  customName: string;
};

/** Reads the hub config and its session row into what the CLI and routes display. */
function hubStatus(config: OrchestratorConfig): HubStatus {
  const hub = config.hub;
  if (!hub?.sessionId) {
    return { sessionId: null, wake: hub?.wake ?? false, provider: null, model: null, effort: null, agent: null, customName: null, exists: false };
  }
  const session = sessionsDb.getSessionById(hub.sessionId);
  return {
    sessionId: hub.sessionId,
    wake: hub.wake ?? true,
    provider: session?.provider ?? null,
    model: session?.model ?? null,
    effort: session?.effort ?? null,
    agent: session?.agent ?? null,
    customName: session?.custom_name ?? null,
    exists: Boolean(session),
  };
}

/**
 * Points the hub at an app session: sets `hub.sessionId` in orchestrator.json,
 * keeping every other hub field (wake, debounceSec, ...) and the rest of the
 * file. The session must exist; switching both ways (Claude <-> OpenCode) is
 * just another session id. The file is read raw rather than round-tripped
 * through OrchestratorConfig so unknown keys survive untouched.
 */
function writeHubSession(sessionId: string, file: string): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // No file yet, or unreadable: the hub entry starts fresh either way.
  }
  const existing = typeof raw.hub === 'object' && raw.hub !== null ? raw.hub as Record<string, unknown> : {};
  const hub = { ...existing, sessionId };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...raw, hub }, null, 2)}\n`, 'utf8');
}

/** The short model name a hub session is titled with (`morph/morph-kimik31` → `morph-kimik31`). */
function shortModelName(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed.slice(trimmed.indexOf('/') + 1) : '';
}

/** Orchestrator hub session management for the routes and `tjob hub`. */
export function createHubService(deps: { config: () => OrchestratorConfig; configFile?: string }) {
  const configFile = () => deps.configFile ?? path.join(os.homedir(), '.config/cli/orchestrator.json');

  return {
    /** `tjob hub`: the active hub session (id, provider, model, effort, agent). */
    status(): HubStatus {
      return hubStatus(deps.config());
    },

    /**
     * `tjob hub use <sessionId>`: switches the hub to an existing app session.
     * Reads the config back after writing, so the answer is what the next
     * config() call will see.
     */
    useSession(sessionId: string): HubStatus {
      if (!sessionsDb.getSessionById(sessionId)) {
        throw new AppError(`Session "${sessionId}" was not found`, { code: 'HUB_SESSION_NOT_FOUND', statusCode: 404 });
      }
      writeHubSession(sessionId, configFile());
      return hubStatus(deps.config());
    },

    /**
     * `tjob hub new`: creates a hub-capable app session (provider + model +
     * effort + agent) in `cwd` (default: the workspace root) and returns it
     * without switching the hub; the person switches with `tjob hub use`.
     */
    createSession(input: {
      provider: string;
      model?: string | null;
      effort?: string | null;
      agent?: string | null;
      cwd?: string | null;
    }): HubSessionCreated {
      if (!providerRuntimeService.hasRuntime(input.provider)) {
        throw new AppError(`Unsupported provider "${input.provider}".`, { code: 'UNSUPPORTED_PROVIDER', statusCode: 400 });
      }
      const provider = input.provider as LLMProvider;
      const projectPath = path.resolve(input.cwd?.trim() || deps.config().workspacesRoot);
      if (!existsSync(projectPath)) {
        throw new AppError(`cwd ${projectPath} does not exist`, { code: 'HUB_CWD_NOT_FOUND', statusCode: 400 });
      }
      const model = input.model?.trim() || null;
      const effort = input.effort?.trim() || null;
      const agent = input.agent?.trim() || null;

      const { sessionId, projectPath: normalizedPath } = sessionsService.createAppSession(
        provider,
        projectPath,
        `Orchestrator hub (${shortModelName(model) || input.provider})`,
      );
      const customName = `Hub · ${shortModelName(model) || input.provider}`;
      sessionsDb.updateSessionCustomName(sessionId, customName);
      if (model) sessionsDb.setSessionModel(sessionId, model);
      if (effort) sessionsDb.setSessionEffort(sessionId, effort);
      if (agent) sessionsDb.setSessionAgent(sessionId, agent);
      return { sessionId, provider: input.provider, projectPath: normalizedPath, model, effort, agent, customName };
    },
  };
}

/** The hub service's API, for the routes and the orchestrator module. */
export type HubService = ReturnType<typeof createHubService>;
