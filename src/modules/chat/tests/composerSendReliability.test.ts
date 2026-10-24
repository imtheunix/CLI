import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { registerPendingSend, takePendingSend } from '@/modules/chat/utils/pendingSends';
import { readQueuedMessages, resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A message the user sent from the composer must never disappear: a dropped
 * socket keeps the text and shows a retry, the retry (manual or automatic on
 * reconnect) delivers it, and a server that rejects the send because a turn is
 * already running hands the message to the durable queue instead of dropping
 * it behind a dead-end error row.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fakeSubmitEvent = () => ({ preventDefault: () => undefined }) as never;

type ChatFrame = { type: string; sessionId?: string; content?: string; clientId?: string };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse([]))));
  localStorage.clear();
  resetChatDrafts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
  resetChatDrafts();
});

const SESSION_B: ProjectSession = { ...SESSION, id: 'session-b', summary: 'B' } as ProjectSession;

type ComposerProps = { socket: WebSocket | null; status: string; session: ProjectSession };

const renderComposer = (sendMessage: (message: unknown) => boolean, ws: WebSocket | null = null) => {
  const established: string[] = [];
  const added: string[] = [];
  const view = renderHook(
    ({ socket, status, session }: ComposerProps) =>
      useChatComposerState({
        selectedProject: PROJECT,
        selectedSession: session,
        currentSessionId: session.id,
        provider: 'claude',
        permissionMode: 'default',
        cyclePermissionMode: () => undefined,
        resolvePermissionModeForProvider: () => 'default' as PermissionMode,
        currentProviderModel: 'test-model',
        currentProviderEffort: 'medium',
        isLoading: false,
        canAbortSession: true,
        tokenBudget: null,
        sendMessage,
        ws: socket,
        connectionStatus: status,
        onSessionEstablished: (sessionId) => { established.push(sessionId); },
        scrollToBottom: () => undefined,
        addMessage: (message) => { added.push(message.type); },
        setIsUserScrolledUp: () => undefined,
        setPendingPermissionRequests: () => undefined,
      }),
    { initialProps: { socket: ws, status: 'disconnected', session: SESSION } as ComposerProps },
  );
  return { view, established, added };
};

test('a send over a dropped socket keeps the composer text and offers a retry that delivers it', async () => {
  let socketUp = false;
  const sent: ChatFrame[] = [];
  const { view, added } = renderComposer((message) => {
    if (!socketUp) {
      return false;
    }
    sent.push(message as ChatFrame);
    return true;
  });

  await act(async () => { view.result.current.setInput('are you there?'); });
  await act(async () => { void view.result.current.handleSubmit(fakeSubmitEvent()); });

  assert.equal(sent.length, 0, 'nothing left the browser');
  assert.equal(view.result.current.input, 'are you there?', 'the text stays in the composer');
  assert.notEqual(view.result.current.failedSend, null, 'the failure is visible');
  assert.deepEqual(added, [], 'no optimistic message for a send that never went out');

  socketUp = true;
  await act(async () => { view.result.current.retryFailedSend(); });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'chat.send');
  assert.equal(sent[0].sessionId, SESSION.id);
  assert.equal(sent[0].content, 'are you there?');
  assert.equal(typeof sent[0].clientId, 'string', 'the frame carries a recovery id');
  assert.equal(view.result.current.input, '', 'the composer clears after delivery');
  assert.equal(view.result.current.failedSend, null, 'the banner is gone');
});

test('the held message retries by itself when the socket comes back', async () => {
  let socketUp = false;
  const sent: ChatFrame[] = [];
  const { view } = renderComposer(
    (message) => {
      if (!socketUp) {
        return false;
      }
      sent.push(message as ChatFrame);
      return true;
    },
    null,
  );

  await act(async () => { view.result.current.setInput('later'); });
  await act(async () => { void view.result.current.handleSubmit(fakeSubmitEvent()); });
  assert.notEqual(view.result.current.failedSend, null);

  // A socket object that is still connecting must not spend the retry.
  const socket = { readyState: 0 } as unknown as WebSocket;
  await act(async () => { view.rerender({ socket, status: 'connecting', session: SESSION }); });
  assert.equal(sent.length, 0);
  assert.notEqual(view.result.current.failedSend, null, 'still held for the real reconnect');

  // The same socket object opens: the status reaching connected sends it.
  socketUp = true;
  await act(async () => { view.rerender({ socket, status: 'connected', session: SESSION }); });

  assert.equal(sent.length, 1, 'the reconnect pushed the held message');
  assert.equal(sent[0].content, 'later');
  assert.equal(view.result.current.failedSend, null);
});

test('a retry sends what the composer holds then, edits included, and clears nothing else', async () => {
  let socketUp = false;
  const sent: ChatFrame[] = [];
  const { view } = renderComposer((message) => {
    if (!socketUp) return false;
    sent.push(message as ChatFrame);
    return true;
  });

  await act(async () => { view.result.current.setInput('draft one'); });
  await act(async () => { void view.result.current.handleSubmit(fakeSubmitEvent()); });
  // Still offline, the user fixes the message before it goes out.
  await act(async () => { view.result.current.setInput('draft one, fixed'); });

  socketUp = true;
  await act(async () => { view.result.current.retryFailedSend(); });
  assert.deepEqual(sent.map((frame) => frame.content), ['draft one, fixed'], 'sent once, as edited');
  assert.equal(view.result.current.input, '');
});

test('a failed send never goes out into another session', async () => {
  let socketUp = false;
  const sent: ChatFrame[] = [];
  const { view } = renderComposer((message) => {
    if (!socketUp) return false;
    sent.push(message as ChatFrame);
    return true;
  });

  await act(async () => { view.result.current.setInput('for session A'); });
  await act(async () => { void view.result.current.handleSubmit(fakeSubmitEvent()); });
  assert.notEqual(view.result.current.failedSend, null);

  // The user moves to session B, then the socket comes back.
  await act(async () => { view.rerender({ socket: null, status: 'disconnected', session: SESSION_B }); });
  assert.equal(view.result.current.failedSend, null, 'B shows no banner for A\'s message');
  socketUp = true;
  await act(async () => { view.rerender({ socket: null, status: 'connected', session: SESSION_B }); });
  assert.equal(sent.length, 0, 'nothing was sent into B');
});

test('a RUN_IN_PROGRESS rejection moves the message into the durable queue instead of an error row', async () => {
  const sessionStore = {
    fetchFromServer: vi.fn(),
    fetchMore: vi.fn(),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => []),
    truncateAt: vi.fn(),
  };
  const listeners: Array<(event: unknown) => void> = [];
  renderHook(() =>
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (listener) => {
        listeners.push(listener as (event: unknown) => void);
        return () => undefined;
      },
      provider: 'claude',
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      setTokenBudget: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
      streamTimerRef: { current: null },
      accumulatedStreamRef: { current: '' },
      lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() },
      onSessionIdle: vi.fn(),
      onSessionProcessing: vi.fn(),
      onSessionBackground: vi.fn(),
      getSessionActivity: vi.fn(),
      requestLatestMessages: vi.fn(),
      sessionStore: sessionStore as never,
    }),
  );

  registerPendingSend({
    clientId: 'client-1',
    sessionKey: SESSION.id,
    content: 'do the thing',
    options: { model: 'test-model' },
    attachments: [],
  });

  act(() => {
    for (const listener of listeners) {
      listener({
        kind: 'protocol_error',
        code: 'RUN_IN_PROGRESS',
        error: `Session "${SESSION.id}" already has a run in progress.`,
        sessionId: SESSION.id,
        clientId: 'client-1',
        timestamp: new Date().toISOString(),
      });
    }
  });

  const queued = readQueuedMessages(SESSION.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].content, 'do the thing');
  assert.equal(sessionStore.appendRealtime.mock.calls.length, 0, 'no dead-end error row is appended');
  assert.equal(takePendingSend('client-1'), null, 'the pending send was consumed exactly once');

  // Without a client id (a foreign client), the old dead-end behaviour stands.
  act(() => {
    for (const listener of listeners) {
      listener({
        kind: 'protocol_error',
        code: 'RUN_IN_PROGRESS',
        error: `Session "${SESSION.id}" already has a run in progress.`,
        sessionId: SESSION.id,
        timestamp: new Date().toISOString(),
      });
    }
  });
  assert.equal(sessionStore.appendRealtime.mock.calls.length, 1, 'an unidentified send still surfaces the error');
});


test('Stop sends chat.abort and a disconnected Stop is retried for its original session', () => {
  let connected = false;
  const frames: ChatFrame[] = [];
  const { view } = renderComposer((frame) => {
    if (!connected) return false;
    frames.push(frame as ChatFrame);
    return true;
  });
  act(() => view.result.current.handleAbortSession());
  assert.deepEqual(frames, []);
  connected = true;
  // Navigation during reconnect must not redirect the stop to another agent.
  view.rerender({ socket: null, status: 'connected', session: SESSION_B });
  assert.deepEqual(frames, [{ type: 'chat.abort', sessionId: SESSION.id }]);
  act(() => view.result.current.handleAbortSession());
  assert.deepEqual(frames.at(-1), { type: 'chat.abort', sessionId: SESSION_B.id });
});
