import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatLiveSync } from '@/modules/chat/hooks/useChatLiveSync';

afterEach(() => vi.restoreAllMocks());

test('attaches on first connection and session handoff, and catches up on reconnect and mobile visibility', () => {
  const sendMessage = vi.fn();
  const requestLatestMessages = vi.fn(async () => {});
  const lastSeqRef = { current: new Map([['canonical', 12]]) };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const options = { sendMessage, requestLatestMessages, lastSeqRef, statusCheckSentAtRef, isActive: true };
  const { rerender, unmount } = renderHook(({ sessionId, connectionStatus }) => useChatLiveSync({ ...options, sessionId, connectionStatus }), {
    initialProps: { sessionId: null as string | null, connectionStatus: 'connecting' },
  });
  rerender({ sessionId: 'canonical', connectionStatus: 'connecting' });
  expect(sendMessage).not.toHaveBeenCalled();
  rerender({ sessionId: 'canonical', connectionStatus: 'connected' });
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.subscribe', sessions: [{ sessionId: 'canonical', lastSeq: 12 }] });
  expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(requestLatestMessages.mock.invocationCallOrder[0]);
  expect(requestLatestMessages).toHaveBeenLastCalledWith('canonical', true);
  rerender({ sessionId: 'canonical', connectionStatus: 'disconnected' });
  rerender({ sessionId: 'canonical', connectionStatus: 'connected' });
  expect(sendMessage).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(sendMessage).toHaveBeenCalledTimes(3);
  rerender({ sessionId: 'another', connectionStatus: 'connected' });
  act(() => window.dispatchEvent(new Event('focus')));
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.subscribe', sessions: [{ sessionId: 'another', lastSeq: 0 }] });
  expect(requestLatestMessages).toHaveBeenLastCalledWith('another', true);
  unmount();
  const count = sendMessage.mock.calls.length;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(sendMessage).toHaveBeenCalledTimes(count);
});

test('a hidden chat subscribes while deferring HTTP history, then catches up on activation', () => {
  const sendMessage = vi.fn();
  const requestLatestMessages = vi.fn(async () => {});
  const options = { sessionId: 'session', connectionStatus: 'connected', sendMessage, requestLatestMessages, lastSeqRef: { current: new Map<string, number>() }, statusCheckSentAtRef: { current: new Map<string, number>() } };
  const { rerender } = renderHook(({ isActive }) => useChatLiveSync({ ...options, isActive }), { initialProps: { isActive: false } });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(requestLatestMessages).toHaveBeenLastCalledWith('session', false);
  rerender({ isActive: true });
  expect(requestLatestMessages).toHaveBeenLastCalledWith('session', true);
});
