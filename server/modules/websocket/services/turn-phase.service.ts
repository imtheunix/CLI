import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { TurnPhase, TurnPhaseState } from '@/shared/types.js';

/**
 * The live turn phase per app session.
 *
 * Phases are ephemeral: they describe what the turn is doing right now, not
 * transcript history. A client that reconnects gets the current phase in its
 * resync snapshot, and the terminal `complete` clears it. Keeping the map here
 * (rather than on the run) lets `queued` exist before a run is reserved.
 */
const phases = new Map<string, TurnPhaseState>();

function broadcast(sessionId: string, state: TurnPhaseState): void {
  const payload = JSON.stringify({
    kind: 'turn_phase',
    sessionId,
    phase: state.phase,
    ...(state.detail ? { detail: state.detail } : {}),
    timestamp: state.at,
  });

  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  }
}

/**
 * Records and announces a session's current phase. Repeating the same phase
 * (a stream of deltas, a tool that keeps reporting) is a no-op so the wire
 * does not carry a phase frame per token.
 */
export function setTurnPhase(sessionId: string, phase: TurnPhase, detail?: string): void {
  const current = phases.get(sessionId);
  if (current?.phase === phase && current.detail === detail) {
    return;
  }

  const state: TurnPhaseState = {
    phase,
    ...(detail ? { detail } : {}),
    at: new Date().toISOString(),
  };
  phases.set(sessionId, state);
  broadcast(sessionId, state);
}

export function getTurnPhase(sessionId: string): TurnPhaseState | null {
  return phases.get(sessionId) ?? null;
}

export function clearTurnPhase(sessionId: string): void {
  phases.delete(sessionId);
}

/** Test-only escape hatch: clears every tracked phase. */
export function clearAllTurnPhases(): void {
  phases.clear();
}
