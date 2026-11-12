import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

const createDiff = (): DiffLine[] => [];

const reasoningMessage = (content: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: '2026-11-10T12:00:00.000Z',
  isThinking: true,
});

const replyMessage = (content: string, isStreaming: boolean): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: '2026-11-10T12:00:01.000Z',
  isStreaming,
});

const renderMessage = (message: ChatMessage, props: {
  isReasoningStreaming?: boolean;
  showReasoningExpanded?: boolean;
} = {}) => (
  <UiPreferencesProvider>
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={createDiff}
      provider="opencode"
      showThinking
      {...props}
    />
  </UiPreferencesProvider>
);

const reasoningTrigger = (container: HTMLElement): HTMLButtonElement => {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
  assert.ok(trigger, 'expected a reasoning trigger');
  return trigger;
};

test('reasoning is one collapsed row while streaming, with a live word count', () => {
  const { container } = render(renderMessage(reasoningMessage('one two three'), {
    isReasoningStreaming: true,
  }));

  const trigger = reasoningTrigger(container);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.match(trigger.textContent ?? '', /Thinking/);
  assert.match(trigger.textContent ?? '', /3 words/);
});

test('reasoning stays collapsed after the turn and reports its word count', () => {
  const { container } = render(renderMessage(reasoningMessage('one two three four')));

  const trigger = reasoningTrigger(container);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.match(trigger.textContent ?? '', /Thought for/);
  assert.match(trigger.textContent ?? '', /4 words/);
});

test('clicking the collapsed row expands the full reasoning text', () => {
  const { container } = render(renderMessage(reasoningMessage('the hidden chain of thought')));

  const trigger = reasoningTrigger(container);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  fireEvent.click(trigger);

  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.match(container.textContent ?? '', /the hidden chain of thought/);
});

test('the "Show reasoning expanded" setting opens the row on first render', () => {
  const { container } = render(renderMessage(reasoningMessage('already open'), {
    showReasoningExpanded: true,
  }));

  assert.equal(reasoningTrigger(container).getAttribute('aria-expanded'), 'true');
});

test('reply text still streams incrementally', () => {
  const { container, rerender } = render(renderMessage(replyMessage('First', true)));

  assert.match(container.textContent ?? '', /First/);
  assert.doesNotMatch(container.textContent ?? '', /First second/);

  rerender(renderMessage(replyMessage('First second', true)));

  assert.match(container.textContent ?? '', /First second/);
});
