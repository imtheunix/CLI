import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import QueuedMessageList from '@/modules/chat/composer/QueuedMessageList';
import SendToLoadBalancerButton from '@/modules/chat/composer/SendToLoadBalancerButton';
import { inferLoadBalancerRepo } from '@/modules/chat/utils/loadBalancerRepo';
import { api } from '@/shared/api';
import type { LoadBalancerContext } from '@/shared/types';
import { readQueuedMessages, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';

vi.mock('@/shared/api', () => ({ api: {
  user: {
    saveDraft: vi.fn(async () => new Response('{}')),
    deleteDraft: vi.fn(async () => new Response('{}')),
  },
  orchestrator: { sendFromSession: vi.fn(), fromSessionContext: vi.fn() },
} }));

const sendFromSession = vi.mocked(api.orchestrator.sendFromSession);
const fromSessionContext = vi.mocked(api.orchestrator.fromSessionContext);

const WORKSPACE: LoadBalancerContext = {
  sessionRepoPath: null,
  workspaceRoot: '/home/me/Tribeira',
  repos: [
    { name: '3gdam', path: '/home/me/Tribeira/3gdam' },
    { name: 'tripam', path: '/home/me/Tribeira/tripam' },
    { name: 'tripam-api', path: '/home/me/Tribeira/tripam-api' },
  ],
};

function inSession(context: Partial<LoadBalancerContext> = {}) {
  fromSessionContext.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...WORKSPACE, ...context } })));
}

function answer(status: number, body: unknown) {
  sendFromSession.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  sendFromSession.mockReset();
  fromSessionContext.mockReset();
});
afterEach(() => { cleanup(); });

test('a queued message can go to the load balancer instead of waiting for this session', async () => {
  writeQueuedMessage('s1', { id: 'first', content: 'Wait for me' });
  writeQueuedMessage('s1', { id: 'second', content: 'Add a dark mode toggle' });
  inSession({ sessionRepoPath: '/home/me/Tribeira/tripam' });
  answer(201, { success: true, data: { job: { id: 'ab12cd34', backend: 'glm', state: 'preparing' } } });
  render(<QueuedMessageList scope="s1" busy />);

  const second = screen.getAllByRole('listitem')[1];
  await act(async () => { fireEvent.click(within(second).getByLabelText('Send to load balancer')); });

  expect(sendFromSession).toHaveBeenCalledWith('s1', 'Add a dark mode toggle', null);
  expect(readQueuedMessages('s1').map((item) => item.id)).toEqual(['first']);
  expect(screen.getByRole('status').textContent).toMatch(/job ab12cd34 to GLM/);
});

test('when the load balancer refuses, the message stays queued and the reason is shown', async () => {
  writeQueuedMessage('s1', { id: 'only', content: 'Do it' });
  inSession({ sessionRepoPath: '/home/me/Tribeira/tripam' });
  answer(400, { success: false, error: { message: 'repo /home/me/Tribeira/gone does not exist' } });
  render(<QueuedMessageList scope="s1" busy />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });

  expect(readQueuedMessages('s1').map((item) => item.id)).toEqual(['only']);
  expect(screen.getByRole('status').textContent).toBe('repo /home/me/Tribeira/gone does not exist');
});

test('the composer button clears the input once sent, and says when every model is busy', async () => {
  inSession({ sessionRepoPath: '/home/me/Tribeira/tripam' });
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

test('from a folder in no repository, the picker asks which one and sends the job there', async () => {
  writeQueuedMessage('s1', { id: 'only', content: 'Ship the release notes' });
  inSession();
  answer(201, { success: true, data: { job: { id: 'aa11', backend: 'glm', state: 'preparing' } } });
  render(<QueuedMessageList scope="s1" busy />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });

  expect(sendFromSession).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Send the job to tripam-api' }).textContent).toContain('/home/me/Tribeira/tripam-api');

  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Send the job to tripam-api' })); });

  expect(sendFromSession).toHaveBeenCalledWith('s1', 'Ship the release notes', '/home/me/Tribeira/tripam-api');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(readQueuedMessages('s1')).toEqual([]);
  expect(screen.getByRole('status').textContent).toMatch(/job aa11 to GLM/);
});

test('cancelling the picker keeps the queued message and sends nothing', async () => {
  writeQueuedMessage('s1', { id: 'only', content: 'Ship the release notes' });
  inSession();
  render(<QueuedMessageList scope="s1" busy />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })); });

  expect(sendFromSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(readQueuedMessages('s1').map((item) => item.id)).toEqual(['only']);
});

test('a message that names exactly one repository skips the picker', async () => {
  writeQueuedMessage('s1', { id: 'only', content: 'Fix the login redirect in tripam-api' });
  inSession();
  answer(201, { success: true, data: { job: { id: 'bb22', backend: 'codex', state: 'preparing' } } });
  render(<QueuedMessageList scope="s1" busy />);

  await act(async () => { fireEvent.click(screen.getByLabelText('Send to load balancer')); });

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(sendFromSession).toHaveBeenCalledWith('s1', 'Fix the login redirect in tripam-api', '/home/me/Tribeira/tripam-api');
  expect(readQueuedMessages('s1')).toEqual([]);
});

test('the inference of the load balancer repository follows the message exactly', () => {
  const repos = WORKSPACE.repos;
  expect(inferLoadBalancerRepo('Fix the login redirect in tripam-api', repos)).toBe('/home/me/Tribeira/tripam-api');
  expect(inferLoadBalancerRepo('TRIPAM: darken the logo', repos)).toBe('/home/me/Tribeira/tripam');
  expect(inferLoadBalancerRepo('Touch both tripam and 3gdam', repos)).toBeNull();
  expect(inferLoadBalancerRepo('Nothing named here', repos)).toBeNull();
  expect(inferLoadBalancerRepo('Refresh the Tribeira workspace itself', repos)).toBeNull();
});
