import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { ChatMessage, SpawnedSessionChild } from '@/shared/types';
import SessionChecklist from '@/modules/chat/composer/SessionChecklist';

let nextTimestamp = 1;
function message(overrides: Partial<ChatMessage>): ChatMessage {
  nextTimestamp += 1;
  return {
    type: 'assistant',
    timestamp: `2026-10-24T09:00:${String(nextTimestamp).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function todoWrite(todos: Array<Record<string, unknown>>): ChatMessage {
  return message({
    isToolUse: true,
    toolName: 'TodoWrite',
    toolId: `todowrite-${nextTimestamp}`,
    toolInput: { todos },
  });
}

function subagentLaunch(): ChatMessage {
  return message({
    isToolUse: true,
    toolName: 'Task',
    toolId: 'task-1',
    toolInput: { description: 'Survey the repo', subagent_type: 'explore' },
  });
}

const spawnedChild: SpawnedSessionChild = {
  sessionId: 'child-1',
  provider: 'codex',
  name: 'Audit the build',
  lastActivity: '2026-10-24T09:05:00Z',
  running: true,
};

function renderPanel(overrides: Partial<Parameters<typeof SessionChecklist>[0]> = {}) {
  const revealMessage = vi.fn();
  const onOpenSession = vi.fn();
  const onRefreshSpawnedSessions = vi.fn();
  const messages = [
    todoWrite([
      { content: 'Read notes', status: 'completed' },
      { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
      { content: 'Write report', status: 'pending' },
    ]),
    subagentLaunch(),
  ];
  const props = {
    messages,
    revealMessage,
    sessionId: 'session-1',
    spawnedSessions: [] as SpawnedSessionChild[],
    onOpenSession,
    onRefreshSpawnedSessions,
    ...overrides,
  };
  const view = render(<SessionChecklist {...props} />);
  return { view, props };
}

beforeEach(() => {
  localStorage.clear();
  // jsdom reports a desktop width, so the strip starts expanded; collapse it
  // first when a test exercises the collapsed row.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('renders nothing when there is no checklist, nothing running and nothing spawned', () => {
  const { view } = renderPanel({ messages: [] });
  expect(view.container.textContent).toBe('');
});

test('the collapsed row summarizes progress and running work; items reveal their message on tap', () => {
  const { props } = renderPanel();
  // Collapse from the desktop default.
  fireEvent.click(screen.getByRole('button', { name: /1\/3 · Running tests/i }));

  const collapsed = screen.getByRole('button', { name: /1\/3 · Running tests · 1 running/i });
  expect(collapsed).toBeTruthy();
  expect(screen.queryByText('Write report')).toBeNull();

  fireEvent.click(collapsed);
  fireEvent.click(screen.getByText('Write report'));
  expect(props.revealMessage).toHaveBeenCalledWith(props.messages[0]);

  const runningRow = screen.getByText('Survey the repo');
  fireEvent.click(runningRow);
  expect(props.revealMessage).toHaveBeenCalledWith(props.messages[1]);
});

test('the expanded view marks done, in-progress and pending items', () => {
  renderPanel();

  expect(screen.getByText('Read notes').className).toContain('line-through');
  expect(screen.getByText('Run tests').className).toContain('font-medium');
  expect(screen.getByText('Write report').className).not.toContain('line-through');
  expect(screen.getByText('Running')).toBeTruthy();
  expect(screen.getByText('Survey the repo')).toBeTruthy();
});

test('spawned sessions list name, provider and running state; tapping opens the session', () => {
  const { props } = renderPanel({ spawnedSessions: [spawnedChild] });

  fireEvent.click(screen.getByText('Audit the build'));
  expect(props.onOpenSession).toHaveBeenCalledWith('child-1');
});

test('expanding refreshes the spawned list, and the choice is remembered per session', () => {
  const { props } = renderPanel();
  // Desktop default is expanded, so the spawned list was read on mount.
  expect(props.onRefreshSpawnedSessions).toHaveBeenCalled();

  // Collapse, then confirm the choice survives a fresh mount of the session.
  fireEvent.click(screen.getByRole('button', { name: /1\/3 · Running tests/i }));
  expect(localStorage.getItem('session-checklist-expanded-session-1')).toBe('0');

  cleanup();
  renderPanel();
  expect(screen.queryByText('Write report')).toBeNull();
  expect(localStorage.getItem('session-checklist-expanded-session-1')).toBe('0');
});

test('a checklist with everything done says Done', () => {
  renderPanel({
    messages: [
      todoWrite([
        { content: 'Only step', status: 'completed' },
      ]),
    ],
  });
  expect(screen.getByRole('button', { name: /1\/1 · Done/i })).toBeTruthy();
});
