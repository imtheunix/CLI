/**
 * Detached turns module:
 * Runs agent turns in isolated transient systemd user units (or fallback background processes),
 * durable per-turn log files, and automatic reattachment across CLI server restarts.
 *
 * What a server restart does to a turn, per backend:
 * - agy, OpenCode: the CLI runs in its own unit (spawnDetachedTurn); the new server tails its log,
 *   or finalizes the turn from the log and exit status if it ended meanwhile.
 * - Claude: the CLI runs under relay/turn-relay.js in its own unit (spawnRelayedTurn); stdin comes
 *   over a unix socket, so the SDK drives it like a child. When the server goes away the relay
 *   denies pending tool permissions, lets the turn reach its `result` and closes stdin, so the CLI
 *   finishes and exits; the new server streams the rest of the log or finalizes it. A new turn on
 *   the session stops a reattached process first (retireDetachedSessionTurns).
 * - Codex: the SDK spawns relay/detached-exec.js (prepareDetachedExec), which runs the CLI in a
 *   relayed unit. Only with a resolved Codex CLI path: with the SDK's bundled binary, or without
 *   systemd-run (any backend), the CLI is a direct child and a restart ends the turn as before.
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

// prepareDetachedExec: used by the Codex runtime to run its SDK's CLI through the relay wrapper
// retireDetachedSessionTurns: used by the Claude runtime to stop a reattached process before a new turn spawns
// spawnRelayedTurn: used by the Claude runtime's spawn hook to run the CLI in a relayed unit
export { prepareDetachedExec, retireDetachedSessionTurns, spawnRelayedTurn } from './services/detached-runner.service.js';
// readRelayExit: the exit status a relayed turn recorded (restart tests)
export { readDeliveredOffset, readRelayExit } from './relay/relay-process.js';

// reattachActiveTurns: used by orchestrator.module.ts on server startup to reconnect to turns across restarts
export { reattachActiveTurns } from './services/detached-runner.service.js';

// registerBackendLineParser: used by providers (claude, codex) to register per-turn stream line parser factories
export { registerBackendLineParser } from './services/detached-runner.service.js';

// spawnDetachedTurn: used by providers (agy, opencode) to run agent turns detached from cloudcli service
export { spawnDetachedTurn } from './services/detached-runner.service.js';

export type {
  DetachedTurnExecution,
  LineHandler,
  RelayedTurnProcess,
} from './services/detached-runner.service.js';
