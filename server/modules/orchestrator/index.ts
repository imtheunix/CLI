// The router and the balancing / CI/CD loop, created and started by the server entrypoint.
export { createOrchestratorModule } from './orchestrator.module.js';
// appendHubEvent: used to emit short state-change notifications for the hub session to tail.
export { appendHubEvent, getHubEventsLogPath } from './services/hub-events.service.js';
export type { HubEventInput, HubEventState } from './services/hub-events.service.js';
