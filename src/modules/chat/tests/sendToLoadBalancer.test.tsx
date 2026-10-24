import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import QueuedMessageList from '@/modules/chat/composer/QueuedMessageList';
import SendToLoadBalancerButton from '@/modules/chat/composer/SendToLoadBalancerButton';
import { api } from '@/shared/api';
import { readQueuedMessages, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';

vi.mock('@/shared/api', () => ({ api: {
  user: {
    saveDraft: vi.fn(async () => new Response('{}')),
    deleteDraft: vi.fn(async () => new Response('{}')),
  },
  orchestrator: { sendFromSession: vi.fn() },
} }));

const sendFromSession = vi.mocked(api.orchestrator.sendFromSession);

function answer(status: number, body: unknown) {
  sendFromSession.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => { localStorage.clear(); resetChatDrafts(); sendFromSession.mockReset(); });
afterEach(() => { cleanup(); });

test('a queued message can go to the load balancer instead of waiting for this session', async () => {
  writeQueuedMessage('s1', { id: 'first', content: 'Wait for me' });
  writeQueuedMessage('s1', { id: 'second', content: 'Add a dark mode toggle' });
  answer(201, { success: true, data: { job: { id: 'ab12cd34', backend: 'glm', state: 'preparing' } } });
  render(<QueuedMessageList scope="s1" busy />);

  const second = screen.getAllByRole('listitem')[1];
  await act(async () => { fireEvent.click(within(second).getByLabelText('Send to load balancer')); });

  expect(sendFromSession).toHaveBeenCalledWith('s1', 'Add a dark mode toggle');
  expect(readQueuedMessages('s1').map((item) => item.id)).toEqual(['first']);
  expect(screen.getByRole('status').textContent).toMatch(/job ab12cd34 to GLM/);
});

test('when the load balancer refuses, the message stays queued and the reason is shown', async () => {
  writeQueuedMessage('s1', { id: 'only', content: 'Do it' });
  answer(400, { success: false, error: { message: '/tmp/x is not a git repository' } });
  render(<QueuedMessageList scope="s1" busy />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });

  expect(readQueuedMessages('s1').map((item) => item.id)).toEqual(['only']);
  expect(screen.getByRole('status').textContent).toBe('/tmp/x is not a git repository');
});

test('the composer button clears the input once sent, and says when every model is busy', async () => {
  answer(201, { success: true, data: { job: { id: 'ef56', backend: null, state: 'queued' } } });
  const onSent = vi.fn();
  render(<SendToLoadBalancerButton compact sessionId="s1" content="Fix the login bug" onSent={onSent} />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });

  expect(onSent).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toMatch(/every model is busy/);
});

test('a message with attached files cannot be sent away', () => {
  writeQueuedMessage('s1', { id: 'files', content: 'Look at this', attachments: [{ name: 'a.png' }] });
  render(<QueuedMessageList scope="s1" busy />);
  const button = screen.getByLabelText('Send to load balancer') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toMatch(/attached files/);
});
