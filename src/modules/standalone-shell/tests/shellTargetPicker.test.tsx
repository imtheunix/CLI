import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ShellTargetPicker from '@/modules/standalone-shell/ShellTargetPicker';

vi.mock('@/modules/shell', () => ({ Shell: ({ launchTarget }: { launchTarget: string }) => <div data-testid="terminal">{launchTarget}</div> }));
const project = { projectId: 'p', displayName: 'Project', fullPath: '/work' };
beforeEach(() => localStorage.clear());
afterEach(cleanup);

test('all five choices are available and the default launches a workstation shell', () => {
  render(<ShellTargetPicker project={project} session={{ id: 'a' }} isActive autoConnect />);
  expect(screen.getAllByRole('option')).toHaveLength(5);
  expect(screen.getByTestId('terminal').textContent).toBe('workstation');
  fireEvent.change(screen.getByLabelText('Shell target'), { target: { value: 'archsv' } });
  expect(screen.getByTestId('terminal').textContent).toBe('archsv');
});

test('a session remembers its choice after remount without changing another session', () => {
  const view = render(<ShellTargetPicker project={project} session={{ id: 'a' }} isActive autoConnect />);
  fireEvent.change(screen.getByLabelText('Shell target'), { target: { value: 'codex' } });
  view.unmount();
  const second = render(<ShellTargetPicker project={project} session={{ id: 'b' }} isActive autoConnect />);
  expect(screen.getByTestId('terminal').textContent).toBe('workstation');
  second.unmount();
  render(<ShellTargetPicker project={project} session={{ id: 'a' }} isActive autoConnect />);
  expect(screen.getByTestId('terminal').textContent).toBe('codex');
});
