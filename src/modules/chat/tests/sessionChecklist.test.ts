import { afterEach, expect, test, vi } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import { deriveSessionChecklist } from '@/modules/chat/utils/sessionChecklist';

let nextTimestamp = 1;
/** A minimal ChatMessage with a fresh timestamp, so every fixture row is its own reveal target. */
function message(overrides: Partial<ChatMessage>): ChatMessage {
  nextTimestamp += 1;
  return {
    type: 'assistant',
    timestamp: `2026-10-24T08:00:${String(nextTimestamp).padStart(2, '0')}Z`,
    ...overrides,
  };
}

function todoWrite(todos: Array<Record<string, unknown>>, asJsonString = false): ChatMessage {
  return message({
    isToolUse: true,
    toolName: 'TodoWrite',
    toolId: `todowrite-${nextTimestamp}`,
    toolInput: asJsonString ? JSON.stringify({ todos }) : { todos },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('todos come from the latest TodoWrite snapshot, in snapshot order', () => {
  const first = todoWrite([
    { content: 'Read notes', status: 'pending' },
    { content: 'Run tests', status: 'pending' },
  ]);
  const latest = todoWrite([
    { content: 'Read notes', status: 'completed' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    { content: 'Write report', status: 'pending' },
  ]);

  const { todos, running } = deriveSessionChecklist([first, latest]);

  expect(todos.map((todo) => [todo.content, todo.status])).toEqual([
    ['Read notes', 'completed'],
    ['Run tests', 'in_progress'],
    ['Write report', 'pending'],
  ]);
  expect(todos[1].activeForm).toBe('Running tests');
  expect(running).toEqual([]);
});

test('a toolInput that arrives as a JSON string is read the same as an object', () => {
  const snapshot = todoWrite([{ content: 'Ship it', status: 'in_progress', activeForm: 'Shipping' }], true);

  const { todos } = deriveSessionChecklist([snapshot]);

  expect(todos).toHaveLength(1);
  expect(todos[0].content).toBe('Ship it');
  expect(todos[0].status).toBe('in_progress');
  expect(todos[0].activeForm).toBe('Shipping');
});

test('each item points at the message its current status was first seen in', () => {
  const seenPending = todoWrite([{ content: 'Read notes', status: 'pending' }]);
  const laterPending = todoWrite([{ content: 'Read notes', status: 'pending' }]);
  const seenDone = todoWrite([{ content: 'Read notes', status: 'completed' }]);
  const stillDone = todoWrite([{ content: 'Read notes', status: 'completed' }]);

  const { todos } = deriveSessionChecklist([seenPending, laterPending, seenDone, stillDone]);

  expect(todos[0].status).toBe('completed');
  expect(todos[0].message).toBe(seenDone);
});

test('running lists subagent and workflow launches without a result, labelled by description or type', () => {
  const agent = message({
    isToolUse: true,
    toolName: 'Task',
    toolId: 'task-1',
    toolInput: { subagent_type: 'explore', description: 'Survey the repo', prompt: '…' },
  });
  const finishedAgent = message({
    isToolUse: true,
    toolName: 'Agent',
    toolId: 'agent-1',
    toolInput: { description: 'Done already', prompt: '…' },
    toolResult: { content: 'ok' },
  });
  const workflow = message({
    isToolUse: true,
    toolName: 'Workflow',
    toolId: 'workflow-1',
    toolInput: JSON.stringify({ name: 'audit', script: 'export const meta = {}' }),
  });

  const { running } = deriveSessionChecklist([agent, finishedAgent, workflow]);

  expect(running).toEqual([
    { kind: 'subagent', label: 'Survey the repo', message: agent },
    { kind: 'workflow', label: 'audit', message: workflow },
  ]);
});

test('a launch with no description falls back to its subagent type', () => {
  const agent = message({
    isToolUse: true,
    toolName: 'Task',
    toolId: 'task-2',
    toolInput: { subagent_type: 'plan', prompt: '…' },
  });

  const { running } = deriveSessionChecklist([agent]);

  expect(running[0].label).toBe('plan');
});

test('a backgrounded launch keeps running until its task status settles even though a result arrived', () => {
  const launched = message({
    isToolUse: true,
    toolName: 'Agent',
    toolId: 'agent-bg',
    toolInput: { description: 'Long survey' },
    // The launch acknowledgement returns immediately; the live stream says running.
    toolResult: { content: 'launched in background' },
    taskStatus: { taskId: 'agent-bg', taskType: 'local_agent', status: 'running' },
  });

  const { running } = deriveSessionChecklist([launched]);

  expect(running).toEqual([{ kind: 'subagent', label: 'Long survey', message: launched }]);
});

test('an empty transcript has no checklist and nothing running', () => {
  expect(deriveSessionChecklist([])).toEqual({ todos: [], running: [] });
});

test('non-checklist tools and unknown statuses are ignored or treated as pending', () => {
  const bash = message({ isToolUse: true, toolName: 'Bash', toolId: 'bash-1', toolInput: { command: 'ls' } });
  const odd = todoWrite([{ content: 'Odd status', status: 'blocked' }]);

  const { todos, running } = deriveSessionChecklist([bash, odd]);

  expect(todos.map((todo) => todo.status)).toEqual(['pending']);
  expect(running).toEqual([]);
});


test('old unresolved foreground launches expire at a user turn, while explicit background work survives', () => {
  const old = message({ isToolUse: true, toolName: 'Agent', toolId: 'old' });
  const background = message({ isToolUse: true, toolName: 'Agent', toolId: 'bg', taskStatus: { taskId: 'bg', taskType: 'local_agent', status: 'running' } });
  const settled = message({ isToolUse: true, toolName: 'Agent', toolId: 'done', taskStatus: { taskId: 'done', taskType: 'local_agent', status: 'completed' } });
  const nextTurn = message({ type: 'user', content: 'Continue' });
  const current = message({ isToolUse: true, toolName: 'Workflow', toolId: 'current' });
  expect(deriveSessionChecklist([old, background, nextTurn, settled, current]).running.map((row) => row.message.toolId)).toEqual(['bg', 'current']);
});

test('a removed checklist item reintroduced with the same status reveals the new plan', () => {
  const first = todoWrite([{ content: 'Test', status: 'pending' }]);
  const cleared = todoWrite([]);
  const restarted = todoWrite([{ content: 'Test', status: 'pending' }]);
  expect(deriveSessionChecklist([first, cleared, restarted]).todos[0].message).toBe(restarted);
});
