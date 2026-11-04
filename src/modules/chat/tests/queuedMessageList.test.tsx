import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import QueuedMessageList from '@/modules/chat/composer/QueuedMessageList';
import { api } from '@/shared/api';
import { readQueuedMessages, replaceQueuedMessages, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';

const socket = vi.hoisted(() => ({ sendMessage: vi.fn(() => true), subscribe: vi.fn((_listener: (event: unknown) => void) => () => {}) }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => socket }));

vi.mock('@/shared/api', () => ({ api: { user: {
  saveDraft: vi.fn(async () => new Response('{}')),
  deleteDraft: vi.fn(async () => new Response('{}')),
} } }));
beforeEach(() => { localStorage.clear(); resetChatDrafts(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); resetChatDrafts(); vi.restoreAllMocks(); });

function seed() {
  writeQueuedMessage('a', { id: 'first', content: 'First', attachments: [{ name: 'image.png' }] });
  writeQueuedMessage('a', { id: 'second', content: 'Second' });
  writeQueuedMessage('b', { id: 'other', content: 'Other session' });
}

test('queue items edit in place, reorder and remove without losing attachments or crossing sessions', () => {
  seed();
  render(<QueuedMessageList scope="a" busy />);
  expect(screen.getAllByRole('textbox')).toHaveLength(2);
  expect(screen.queryByDisplayValue('Other session')).toBeNull();
  fireEvent.change(screen.getByLabelText('Queued message 1'), { target: { value: 'Edited' } });
  expect(readQueuedMessages('a')[0].content).toBe('Edited');
  expect(readQueuedMessages('a')[0].attachments).toEqual([{ name: 'image.png' }]);
  fireEvent.click(screen.getByLabelText('Move queued message 2 up'));
  expect(readQueuedMessages('a').map((item) => item.id)).toEqual(['second', 'first']);
  fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByText('Remove'));
  expect(readQueuedMessages('a').map((item) => item.id)).toEqual(['first']);
  expect(readQueuedMessages('b')[0].content).toBe('Other session');
});

test.each([true, false])('Send now immediately sends the chosen item over the socket when busy=%s', async (busy) => {
  await act(async () => { seed(); });
  vi.mocked(api.user.saveDraft).mockClear();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<QueuedMessageList scope="a" busy={busy} />);
  const sendNow = screen.getAllByRole('button', { name: 'Send now' })[1] as HTMLButtonElement;
  expect(sendNow.disabled).toBe(false);
  expect(sendNow.title).toBe(busy
    ? 'Delivers this message to the running turn at its next opportunity.'
    : 'Sends this message now, ahead of the rest of the queue.');
  fireEvent.click(sendNow);
  await waitFor(() => expect(socket.sendMessage).toHaveBeenCalledWith({ type: 'chat.queue-send', sessionId: 'a', messageId: 'second' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(readQueuedMessages('a').map((item) => item.id)).toEqual(['first', 'second']);
  expect(api.user.saveDraft).not.toHaveBeenCalled();
});

test.each([500, 507, 400])('a failed Send now save (%s) shows an error and can be retried', async (status) => {
  await act(async () => { seed(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(api.user.saveDraft).mockResolvedValueOnce(new Response('{}', { status }));
  render(<QueuedMessageList scope="a" busy />);
  const sendNow = screen.getAllByRole('button', { name: 'Send now' })[1] as HTMLButtonElement;
  replaceQueuedMessages('a', readQueuedMessages('a'));
  fireEvent.click(sendNow);
  expect((await screen.findByRole('alert')).textContent).toContain('Queue changes could not be saved');
  expect(sendNow.disabled).toBe(false);
  expect(readQueuedMessages('a').map((item) => item.id)).toEqual(['first', 'second']);

  fireEvent.click(sendNow);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(socket.sendMessage).toHaveBeenCalledWith({ type: 'chat.queue-send', sessionId: 'a', messageId: 'second' });
});

test('a paused queue remains editable and can be explicitly resumed', () => {
  seed();
  replaceQueuedMessages('a', readQueuedMessages('a'), true);
  render(<QueuedMessageList scope="a" busy={false} />);
  expect(screen.getByText(/Queue paused/)).toBeTruthy();
  fireEvent.click(screen.getByText('Resume queue'));
  expect(JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage.paused).toBe(false);
});

test('a disconnected socket keeps the item and reports that delivery did not happen', async () => {
  await act(async () => { seed(); });
  socket.sendMessage.mockReturnValueOnce(false);
  render(<QueuedMessageList scope="a" busy />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[0]);
  expect((await screen.findByRole('status')).textContent).toContain('Not connected');
  expect(readQueuedMessages('a')).toHaveLength(2);
});

test('only an interrupt fallback request prompts for confirmation', async () => {
  await act(async () => { seed(); });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<QueuedMessageList scope="a" busy />);
  const listener = socket.subscribe.mock.calls.at(-1)![0] as (event: unknown) => void;
  act(() => listener({ kind: 'queue_interrupt_required', sessionId: 'a', messageId: 'second' }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(socket.sendMessage).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  act(() => listener({ kind: 'queue_interrupt_required', sessionId: 'a', messageId: 'second' }));
  expect(socket.sendMessage).toHaveBeenCalledWith({ type: 'chat.queue-send', sessionId: 'a', messageId: 'second', allowInterrupt: true });
});

test('a legacy item receives a persisted address before socket delivery', async () => {
  await act(async () => { replaceQueuedMessages('a', [{ content: 'legacy draft' }]); });
  render(<QueuedMessageList scope="a" busy />);
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(socket.sendMessage).toHaveBeenCalledWith({ type: 'chat.queue-send', sessionId: 'a', messageId: 'legacy-0' }));
  expect(api.user.saveDraft).toHaveBeenLastCalledWith('a', expect.objectContaining({
    queuedMessage: expect.objectContaining({ items: [expect.objectContaining({ id: 'legacy-0', content: 'legacy draft' })] }),
  }));
});
