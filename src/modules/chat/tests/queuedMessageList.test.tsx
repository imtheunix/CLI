import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import QueuedMessageList from '@/modules/chat/composer/QueuedMessageList';
import { api } from '@/shared/api';
import { readQueuedMessages, replaceQueuedMessages, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';

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

test.each([true, false])('Send now is enabled and forces the chosen item when busy=%s', async (busy) => {
  await act(async () => { seed(); });
  vi.mocked(api.user.saveDraft).mockClear();
  // The tap itself is the confirmation: the server stops a running turn and
  // sends the forced item next, so no dialog stands between them.
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<QueuedMessageList scope="a" busy={busy} />);
  const sendNow = screen.getAllByRole('button', { name: 'Send now' })[1] as HTMLButtonElement;
  expect(sendNow.disabled).toBe(false);
  expect(sendNow.title).toBe(busy
    ? 'Stops the running turn, as Stop does, and sends this message as the next turn.'
    : 'Sends this message now, ahead of the rest of the queue.');
  fireEvent.click(sendNow);
  const queue = JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage;
  expect(queue.forceId).toBe('second');
  expect(queue.items.map((item: { id: string }) => item.id)).toEqual(['first', 'second']);
  expect(confirm).not.toHaveBeenCalled();
  await waitFor(() => expect(api.user.saveDraft).toHaveBeenCalledWith('a', expect.objectContaining({
    queuedMessage: expect.objectContaining({ forceId: 'second', paused: false }),
  })));
});

test.each([500, 507, 400])('a failed Send now save (%s) shows an error and can be retried', async (status) => {
  await act(async () => { seed(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(api.user.saveDraft).mockResolvedValueOnce(new Response('{}', { status }));
  render(<QueuedMessageList scope="a" busy />);
  const sendNow = screen.getAllByRole('button', { name: 'Send now' })[1] as HTMLButtonElement;
  fireEvent.click(sendNow);
  expect((await screen.findByRole('alert')).textContent).toContain('Queue changes could not be saved');
  expect(sendNow.disabled).toBe(false);
  expect(readQueuedMessages('a').map((item) => item.id)).toEqual(['first', 'second']);

  fireEvent.click(sendNow);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage.forceId).toBe('second');
});

test('a paused queue remains editable and can be explicitly resumed', () => {
  seed();
  replaceQueuedMessages('a', readQueuedMessages('a'), true);
  render(<QueuedMessageList scope="a" busy={false} />);
  expect(screen.getByText(/Queue paused/)).toBeTruthy();
  fireEvent.click(screen.getByText('Resume queue'));
  expect(JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage.paused).toBe(false);
});
