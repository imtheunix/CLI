import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

type LiveSyncOptions = {
  sessionId: string | null;
  connectionStatus: string;
  isActive: boolean;
  sendMessage: (message: unknown) => unknown;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  lastSeqRef: MutableRefObject<Map<string, number>>;
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
};

/** Used by ChatInterface to recover a session after navigation, reconnect, or browser suspension. */
export function useChatLiveSync({ sessionId, connectionStatus, isActive, sendMessage, requestLatestMessages, lastSeqRef, statusCheckSentAtRef }: LiveSyncOptions) {
  useEffect(() => {
    if (!sessionId || connectionStatus !== 'connected') return;
    const sync = () => {
      // Attach before fetching: events produced during the history request must
      // already have a live audience. Also works before selectedSession catches up.
      statusCheckSentAtRef.current.set(sessionId, Date.now());
      sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: lastSeqRef.current.get(sessionId) ?? 0 }] });
      void requestLatestMessages(sessionId, isActive && document.visibilityState !== 'hidden');
    };
    const onVisible = () => { if (document.visibilityState !== 'hidden') sync(); };
    sync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [sessionId, connectionStatus, isActive, sendMessage, requestLatestMessages, lastSeqRef, statusCheckSentAtRef]);
}
