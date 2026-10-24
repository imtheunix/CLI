import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import QueuedMessageList from '@/modules/chat/composer/QueuedMessageList';
import { readQueuedMessages, replaceQueuedMessages, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';

vi.mock('@/shared/api', () => ({ api: { user: {
  saveDraft: vi.fn(async () => new Response('{}')),
  deleteDraft: vi.fn(async () => new Response('{}')),
} } }));
beforeEach(() => { localStorage.clear(); resetChatDrafts(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

test('Send now targets the chosen item without asking to interrupt anything', () => {
  seed();
  // The running turn is never interrupted anymore (the server hands the
  // message over or queues it first in line), so a busy session must not
  // stand between the tap and the force flag.
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<QueuedMessageList scope="a" busy />);
  fireEvent.click(screen.getAllByText('Send now')[1]);
  const queue = JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage;
  expect(queue.forceId).toBe('second');
  expect(queue.items.map((item: { id: string }) => item.id)).toEqual(['first', 'second']);
  expect(confirm).not.toHaveBeenCalled();
});

test('a paused queue remains editable and can be explicitly resumed', () => {
  seed();
  replaceQueuedMessages('a', readQueuedMessages('a'), true);
  render(<QueuedMessageList scope="a" busy={false} />);
  expect(screen.getByText(/Queue paused/)).toBeTruthy();
  fireEvent.click(screen.getByText('Resume queue'));
  expect(JSON.parse(localStorage.getItem('chat-drafts')!).a.queuedMessage.paused).toBe(false);
});
