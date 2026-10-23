import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BackgroundJobs } from '@/modules/background-jobs';

const { list, detail } = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { backgroundJobs: { list, detail } } }));
const job = { id: 'one', title: 'Research', tool: 'agy', machine: 'archsv', status: 'running', startedAt: '2026-10-23T10:00:00Z' };
const response = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => {
  list.mockReset().mockImplementation(async () => response({ jobs: [job] }));
  detail.mockReset().mockImplementation(async () => response({ job, log: '<script>literal log</script>', summary: '' }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('a visible list opens bounded plain-text output and refreshes completed status and summary', async () => {
  render(<BackgroundJobs visible />);
  await screen.findByText('Research');
  expect(screen.getByText('agy · archsv · running')).toBeTruthy();
  fireEvent.click(screen.getByText('Research'));
  await screen.findByText('<script>literal log</script>');
  expect(document.querySelector('script')).toBeNull();
  list.mockImplementation(async () => response({ jobs: [{ ...job, status: 'done' }] }));
  detail.mockImplementation(async () => response({ job: { ...job, status: 'done' }, log: 'Finished', summary: 'Findings' }));
  fireEvent(document, new Event('visibilitychange'));
  await screen.findByText('Findings');
  expect(screen.getByText('agy · archsv · done')).toBeTruthy();
});

test('polls every ten seconds only while visible and cleans up its interval', async () => {
  vi.useFakeTimers();
  const view = render(<BackgroundJobs visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(list).toHaveBeenCalledTimes(2);
  view.rerender(<BackgroundJobs visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(list).toHaveBeenCalledTimes(2);
});
