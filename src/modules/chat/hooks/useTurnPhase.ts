import { useEffect, useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent, TurnPhase } from '@/shared/types';

function readPhase(value: unknown): TurnPhase | null {
  return typeof value === 'string' && value.length > 0 ? value as TurnPhase : null;
}

/**
 * The viewed session's live turn phase, from the chat websocket.
 *
 * `turn_phase` frames carry it while a turn runs; `chat_subscribed` and
 * `chat_resync` carry the current one on (re)connect, so a refreshed tab shows
 * the badge without waiting for the next phase change. `complete` clears it.
 */
export function useTurnPhase(sessionId: string | null): TurnPhase | null {
  const { subscribe } = useWebSocket();
  // The session the last frame described, kept with the phase so switching
  // sessions never shows the previous conversation's phase for a render.
  const [state, setState] = useState<{ sessionId: string | null; phase: TurnPhase | null }>({
    sessionId: null,
    phase: null,
  });

  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }

    return subscribe((event: ServerEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      if (event.kind === 'turn_phase') {
        setState({ sessionId, phase: readPhase(event.phase) });
        return;
      }

      if (event.kind === 'chat_subscribed' || event.kind === 'chat_resync') {
        setState({ sessionId, phase: readPhase(event.phase) });
        return;
      }

      if (event.kind === 'complete') {
        setState({ sessionId, phase: null });
      }
    });
  }, [sessionId, subscribe]);

  return state.sessionId === sessionId ? state.phase : null;
}
