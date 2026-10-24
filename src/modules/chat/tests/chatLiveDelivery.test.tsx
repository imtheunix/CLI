import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

function renderHandlers() {
  let listener: (event: ServerEvent) => void = () => {};
  const store = { appendRealtime: vi.fn(), updateStreaming: vi.fn(), finalizeStreaming: vi.fn(), getMessages: () => [] };
  const idle = vi.fn();
  const processing = vi.fn();
  const refresh = vi.fn(async () => {});
  const lastSeqRef = { current: new Map<string, number>() };
  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: '' };
  const { rerender, unmount } = renderHook(({ id }) => useChatRealtimeHandlers({
    isActive: true, subscribe: (fn) => { listener = fn; return () => {}; }, provider: 'claude',
    selectedSession: id ? { id } as ProjectSession : null, currentSessionId: id,
    setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
    streamTimerRef, accumulatedStreamRef, lastSeqRef, statusCheckSentAtRef: { current: new Map() },
    onSessionIdle: idle, onSessionProcessing: processing,
    requestLatestMessages: refresh, sessionStore: store as unknown as SessionStore,
  }), { initialProps: { id: 'canonical' } });
  return { store, idle, processing, refresh, lastSeqRef, accumulatedStreamRef, rerender, unmount,
    dispatch: (frame: Record<string, unknown>) => act(() => listener(frame as unknown as ServerEvent)),
  };
}

test('abort completion clears running UI and permissions; repeated replay frames are ignored', () => {
  const { dispatch, idle, processing, store } = renderHandlers();
  dispatch({ kind: 'status', sessionId: 'canonical', seq: 1, text: 'Processing' });
  expect(processing).toHaveBeenCalledWith('canonical', expect.anything());
  dispatch({ kind: 'text', sessionId: 'canonical', seq: 2, id: 'answer', content: 'visible immediately' });
  dispatch({ kind: 'text', sessionId: 'canonical', seq: 2, id: 'answer', content: 'visible immediately' });
  expect(store.appendRealtime).toHaveBeenCalledTimes(1);
  dispatch({ kind: 'complete', sessionId: 'canonical', seq: 3, aborted: true });
  expect(idle).toHaveBeenCalledWith('canonical');
});

test('a reset server cursor accepts replay again and an idle subscription fetches missed completed responses', () => {
  const { dispatch, lastSeqRef, refresh, store } = renderHandlers();
  lastSeqRef.current.set('canonical', 100);
  dispatch({ kind: 'chat_subscribed', sessionId: 'canonical', lastSeq: 2, isProcessing: true, pendingPermissions: [] });
  dispatch({ kind: 'text', sessionId: 'canonical', seq: 1, content: 'after server restart' });
  expect(store.appendRealtime).toHaveBeenCalledTimes(1);
  dispatch({ kind: 'chat_subscribed', sessionId: 'canonical', lastSeq: 2, isProcessing: false, pendingPermissions: [] });
  expect(refresh).toHaveBeenCalledWith('canonical', true);
});

test('another subscribed session cannot mix its stream into the viewed response or flush its buffer', () => {
  const { dispatch, accumulatedStreamRef, store, unmount } = renderHandlers();
  dispatch({ kind: 'stream_delta', sessionId: 'canonical', seq: 1, content: 'viewed text' });
  dispatch({ kind: 'stream_delta', sessionId: 'another', seq: 1, content: 'other text' });
  dispatch({ kind: 'complete', sessionId: 'another', seq: 2, aborted: true });
  expect(accumulatedStreamRef.current).toBe('viewed text');
  expect(store.updateStreaming).not.toHaveBeenCalled();
  dispatch({ kind: 'stream_end', sessionId: 'canonical', seq: 2 });
  expect(store.updateStreaming).toHaveBeenCalledWith('canonical', 'viewed text', 'claude');
  unmount();
});
