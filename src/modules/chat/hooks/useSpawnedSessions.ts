import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SpawnedSessionChild, ServerEvent } from '@/shared/types';

type SessionDetailsWithSpawnedSessions = {
  data?: {
    spawnedSessions?: SpawnedSessionChild[];
  };
};

/**
 * Used by ChatInterface to list the sessions the open one spawned, for the
 * composer checklist panel's "Spawned sessions" section.
 *
 * Refreshes on sidebar upserts so a newly spawned child can reveal an empty
 * panel. A bounded poll keeps existing children's running state fresh, and
 * session switches cancel stale responses.
 */
export function useSpawnedSessions(
  sessionId: string | null,
  subscribe: (listener: (event: ServerEvent) => void) => () => void,
): {
  children: SpawnedSessionChild[];
  refresh: () => void;
} {
  // Retains the last successful detail response while a refresh is pending.
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
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await api.sessionDetails(sessionId);
        const payload = await readApiJson<SessionDetailsWithSpawnedSessions>(response);
        const spawned = payload.data?.spawnedSessions;
        if (!cancelled && Array.isArray(spawned)) {
          setChildren(spawned);
        }
      } catch {
        // A failed read leaves the previous list; the panel just shows none.
      } finally {
        pending = false;
      }
    };
    void read();
    // Coalesce bursts of file watcher events into one detail fetch.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.kind !== 'session_upserted') return;
      const session = event.session as { spawnedBySessionId?: string; id?: string };
      if (session.spawnedBySessionId !== sessionId) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void read(); }, 200);
    });
    const timer = setInterval(() => { void read(); }, 15_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearTimeout(refreshTimer);
      clearInterval(timer);
    };
  }, [sessionId, readCount, subscribe]);

  const refresh = useCallback(() => {
    setReadCount((previous) => previous + 1);
  }, []);

  return { children, refresh };
}
