import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SpawnedSessionChild } from '@/shared/types';

type SessionDetailsWithSpawnedSessions = {
  data?: {
    spawnedSessions?: SpawnedSessionChild[];
  };
};

/**
 * Used by ChatInterface to list the sessions the open one spawned, for the
 * composer checklist panel's "Spawned sessions" section.
 *
 * Reads once per session so opening a chat does not add a poll; `refresh`
 * re-reads on demand, which the panel calls when it expands so a session that
 * appeared since the chat was opened still shows up.
 */
export function useSpawnedSessions(sessionId: string | null): {
  children: SpawnedSessionChild[];
  refresh: () => void;
} {
  const [children, setChildren] = useState<SpawnedSessionChild[]>([]);
  // Bumped by refresh() to re-run the read without changing the session.
  const [readCount, setReadCount] = useState(0);
  // Reset during render (the React-recommended pattern) rather than in an
  // effect, so switching sessions never briefly lists the previous one's
  // spawned sessions under the new session's panel.
  const [lastSessionId, setLastSessionId] = useState(sessionId);
  if (sessionId !== lastSessionId) {
    setLastSessionId(sessionId);
    setChildren([]);
  }

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await api.sessionDetails(sessionId);
        const payload = await readApiJson<SessionDetailsWithSpawnedSessions>(response);
        const spawned = payload.data?.spawnedSessions;
        if (!cancelled && Array.isArray(spawned)) {
          setChildren(spawned);
        }
      } catch {
        // A failed read leaves the previous list; the panel just shows none.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, readCount]);

  const refresh = useCallback(() => {
    setReadCount((previous) => previous + 1);
  }, []);

  return { children, refresh };
}
