import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Plans } from '@/modules/plans';

const usage = vi.fn();
const history = vi.fn();
vi.mock('@/shared/api', () => ({ plansApi: { usage: () => usage(), history: (plan: string) => history(plan) } }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); usage.mockReset(); history.mockReset(); });

test('missing configuration is clear and needs no history calls', async () => {
  usage.mockResolvedValue(Response.json({ configured: false }));
  render(<Plans />);
  expect(await screen.findByText('Plans is not configured.')).toBeTruthy();
  expect(history).not.toHaveBeenCalled();
});

test('shows quota, reset time, stale readings and history for each own-account plan', async () => {
  usage.mockResolvedValue(Response.json([{ plan: 'claude', at: '2020-01-01T00:00:00Z', note: 'Own subscription', windows: [{ id: 'week', label: 'Weekly', usedPercent: 42, resetsAt: '2030-01-01T00:00:00Z' }] }]));
  history.mockImplementation(async () => Response.json([]));
  render(<Plans />);
  expect(await screen.findByText('Weekly: 42% used')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Claude Weekly used' })).toBeTruthy();
  expect(screen.getByText(/Stale/)).toBeTruthy();
  expect(screen.getByRole('article', { name: 'ChatGPT' })).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Google' })).toBeTruthy();
  await waitFor(() => expect(history).toHaveBeenCalledTimes(3));
});

test('refreshes each minute only while visible and stops after leaving Plans', async () => {
  vi.useFakeTimers();
  usage.mockImplementation(async () => Response.json([]));
  history.mockImplementation(async () => Response.json([]));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = render(<Plans />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(usage).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(usage).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(usage).toHaveBeenCalledTimes(3);
  view.rerender(<Plans isVisible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(usage).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(usage).toHaveBeenCalledTimes(3);
});
