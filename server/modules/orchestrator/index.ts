// The router and the balancing / CI/CD loop, created and started by the server entrypoint.
export { createOrchestratorModule } from './orchestrator.module.js';
// appendHubEvent: used to emit short state-change notifications for the hub session to tail.
export { appendHubEvent, getHubEventsLogPath, onHubEvent } from './services/hub-events.service.js';
export type { HubEventInput, HubEventState } from './services/hub-events.service.js';
// HubWakeService: wakes the orchestrating hub session on job events.
export { createHubWakeService } from './services/hub-wake.service.js';
export type { HubWakeService, HubWakeDependencies, LoggedHubEvent } from './services/hub-wake.service.js';
export type { HubWakeConfig } from './services/orchestrator-config.service.js';
