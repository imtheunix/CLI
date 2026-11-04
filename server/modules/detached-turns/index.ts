/**
 * Detached turns module:
 * Runs agent turns in isolated transient systemd user units (or fallback background processes),
 * durable per-turn log files, and automatic reattachment across CLI server restarts.
 */

// abortTurn: used by providers (agy, opencode, codex, claude) and websocket chat-abort to stop in-flight turns
export { abortTurn } from './services/detached-runner.service.js';

// generateUnitName, getTurnLogPath, getTurnsDirectory, getUnitExitCode, isTurnAlive, isSystemdRunAvailable, resetSystemdRunCache, tailLogFile:
// used by providers and restart integration tests
export {
  generateUnitName,
  getTurnLogPath,
  getTurnsDirectory,
  getUnitExitCode,
  isSystemdRunAvailable,
  isTurnAlive,
  resetSystemdRunCache,
  tailLogFile,
} from './services/detached-runner.service.js';

// reattachActiveTurns: used by orchestrator.module.ts on server startup to reconnect to turns across restarts
export { reattachActiveTurns } from './services/detached-runner.service.js';

// registerBackendLineParser: used by providers (agy, opencode) to register stream line parsers
export { registerBackendLineParser } from './services/detached-runner.service.js';

// spawnDetachedTurn: used by providers (agy, opencode) to run agent turns detached from cloudcli service
export { spawnDetachedTurn } from './services/detached-runner.service.js';

export type {
  DetachedTurnExecution,
  LineHandler,
} from './services/detached-runner.service.js';
