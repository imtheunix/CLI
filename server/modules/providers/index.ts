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

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// TOOLS_REQUIRING_INTERACTION: used by evals/harness to verify interactive blocking tools in unattended jobs.
export { TOOLS_REQUIRING_INTERACTION } from './list/claude/claude-runtime.provider.js';

// ZCode plan and model selection: used by evals/harness to verify ZCode model and reasoningLevel selection.
export { writeZcodeSelection, readSelectionState, planCandidates, classifyPlanFailure, ZCODE_PLANS } from './list/zcode/zcode-selection.js';
export type { ZcodePlan } from './list/zcode/zcode-selection.js';
