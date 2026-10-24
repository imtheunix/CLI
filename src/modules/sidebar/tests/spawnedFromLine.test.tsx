import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * A session spawned from another session's shell carries its parent's id and
 * name on the row. The line must show for both layouts and open the parent
 * session (and only the parent — not the row it lives in).
 */

let isCompactLayout = false;

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => isCompactLayout,
}));

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: () => null,
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-10-24T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;
const SESSION = {
  id: 'spawned-1',
  summary: 'Codex audit run',
  lastActivity: '2026-10-24T09:59:00.000Z',
  __provider: 'codex',
  spawnedBySessionId: 'parent-1',
  spawnedByName: 'Fix the login flow',
} as unknown as SessionWithProvider;

const renderRow = (session: SessionWithProvider, onSessionSelect = noop) => render(
  React.createElement(MemoryRouter, null, React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session,
    selectedSession: null,
    isProcessing: false,
    hasBackgroundWork: false,
    needsAttention: false,
    currentTime: NOW,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect,
    onDeleteSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
  })),
);

beforeEach(() => {
  isCompactLayout = false;
});

test('a spawned session says where it came from and opens the parent on tap', () => {
  const onSessionSelect = vi.fn();
  const { container, unmount } = renderRow(SESSION, onSessionSelect);

  const spawnedLine = [...container.querySelectorAll('[role="button"], button')]
    .find((element) => element.textContent === '↳ from Fix the login flow');
  assert.ok(spawnedLine, 'the row shows the spawned-from line with the parent name');

  fireEvent.click(spawnedLine!);
  assert.equal(onSessionSelect.mock.calls.length, 0, 'the tap opens the parent, not the row itself');
  assert.ok(
    container.textContent!.includes('Codex audit run'),
    'the row itself stays rendered after the tap',
  );
  unmount();
});

test('the spawned-from line shows for the compact layout too', () => {
  isCompactLayout = true;
  const onSessionSelect = vi.fn();
  const { container } = renderRow(SESSION, onSessionSelect);

  const spawnedLine = [...container.querySelectorAll('button')]
    .find((element) => element.textContent === '↳ from Fix the login flow');
  assert.ok(spawnedLine, 'the compact row shows the spawned-from line');

  // The compact row opens the session on any tap on the card itself; the line
  // must stop that so only the parent opens.
  fireEvent.click(spawnedLine!);
  assert.equal(onSessionSelect.mock.calls.length, 0);
});

test('a session without a recorded parent shows no line', () => {
  const plainSession = {
    id: 'plain-1',
    summary: 'Ordinary session',
    lastActivity: '2026-10-24T09:59:00.000Z',
    __provider: 'claude',
  } as unknown as SessionWithProvider;

  const { container } = renderRow(plainSession);

  assert.equal([...container.querySelectorAll('[role="button"], button')]
    .filter((element) => element.textContent?.startsWith('↳')).length, 0);
});

test('a missing parent name still identifies the parent session', () => {
  const unnamedParent = {
    ...SESSION,
    spawnedByName: null,
  } as unknown as SessionWithProvider;

  const { container } = renderRow(unnamedParent);

  assert.ok([...container.querySelectorAll('[role="button"], button')]
    .some((element) => element.textContent === '↳ from another session'));
});
