import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { ServerEvent, SpawnedSessionChild } from '@/shared/types';
import { useSpawnedSessions } from '@/modules/chat/hooks/useSpawnedSessions';

vi.mock('@/shared/api', () => ({
  api: { sessionDetails: vi.fn() },
  readApiJson: (response: Response) => response.json(),
}));

const child: SpawnedSessionChild = { sessionId: 'child', name: 'Child', provider: 'codex', running: true, lastActivity: null };
const response = (children: SpawnedSessionChild[]) => new Response(JSON.stringify({ data: { spawnedSessions: children } }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

test('a response for a previous session never replaces the current children', async () => {
  let resolveFirst!: (response: Response) => void;
  vi.mocked(api.sessionDetails).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(response([]));
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const { result, rerender, unmount } = renderHook(({ id }) => useSpawnedSessions(id, subscribe), { initialProps: { id: 'first' } });
  rerender({ id: 'second' });
  await waitFor(() => expect(api.sessionDetails).toHaveBeenCalledWith('second'));
  await act(async () => { resolveFirst(response([child])); });
  expect(result.current.children).toEqual([]);
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

test('a live child discovery refreshes an initially empty panel and polling settles running state', async () => {
  vi.useFakeTimers();
  let listener!: (event: ServerEvent) => void;
  const subscribe = (callback: typeof listener) => { listener = callback; return vi.fn(); };
  vi.mocked(api.sessionDetails).mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(response([child]))
    .mockResolvedValueOnce(response([{ ...child, running: false }]));
  const { result, unmount } = renderHook(() => useSpawnedSessions('parent', subscribe));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  act(() => {
    listener({ kind: 'session_upserted', session: { id: 'child', spawnedBySessionId: 'parent' } } as unknown as ServerEvent);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(result.current.children).toEqual([child]);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(result.current.children[0].running).toBe(false);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
