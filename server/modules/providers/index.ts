export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

// providerAuthService: used by the Orchestrator to probe a backend's login before resuming a job that waited on it.
export { providerAuthService } from './services/provider-auth.service.js';

// zcode probe: used by the Orchestrator dispatch path to probe ZCode login before starting GLM/zcode turns.
export {
  isZcodeProbeHealthy,
  probeZcodeLogin,
  recordZcodeSuccess,
  resetZcodeProbeCache,
} from './list/zcode/zcode-probe.js';

// providerTokenUsageService: used by orchestrator jobs service and routes to compute token usage and notional cost.
export { providerTokenUsageService } from './services/provider-token-usage.service.js';
export { clearScanCache } from './services/usage-scan-cache.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// Kimi turn budgets: used by the Orchestrator status efficiency report.
export {
  evaluateKimiCallUsage,
  KIMI_CALL_UNCACHED_INPUT_TOKENS,
  KIMI_TASK_SPLIT_MS,
  KIMI_TURN_OUTPUT_TOKENS,
  type KimiBudgetWarning,
} from './shared/kimi-turn-budget.js';
