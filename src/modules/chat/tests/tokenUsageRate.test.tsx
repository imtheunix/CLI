import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

const usage = (overrides: Record<string, unknown> = {}) => ({
  used: 1_234,
  inputTokens: 1_000,
  outputTokens: 234,
  ...overrides,
});

test('shows the measured rate while the turn generates', () => {
  const { container } = render(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 42.5 })} isGenerating />);

  assert.match(container.textContent ?? '', /42\.5 tok\/s/);
  assert.doesNotMatch(container.textContent ?? '', /last/);
});

test('after the turn ends the last measured rate is labelled as such', () => {
  const { container } = render(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 42.5 })} isGenerating={false} />);

  assert.match(container.textContent ?? '', /last 42\.5 tok\/s/);
});

test('an unavailable rate is an explicit em dash, never an invented number', () => {
  const { container } = render(<TokenUsageSummary usage={usage()} isGenerating />);

  assert.match(container.textContent ?? '', /—/);
  assert.doesNotMatch(container.textContent ?? '', /tok\/s/);
});

test('a previous turn\'s rate is not shown as live until the new turn reports usage', () => {
  const previous = usage({ outputTokensPerSecond: 10 });
  const { container, rerender } = render(<TokenUsageSummary usage={previous} isGenerating={false} />);
  assert.match(container.textContent ?? '', /last 10\.0 tok\/s/);

  rerender(<TokenUsageSummary usage={previous} isGenerating />);
  assert.match(container.textContent ?? '', /—/, 'the old rate is not live for the new turn');

  rerender(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 20 })} isGenerating />);
  assert.match(container.textContent ?? '', /20\.0 tok\/s/);
});

test('switching to a session with no usage clears the rate', () => {
  const { container, rerender } = render(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 30 })} isGenerating />);
  assert.match(container.textContent ?? '', /30\.0 tok\/s/);

  rerender(<TokenUsageSummary usage={null} isGenerating />);
  assert.match(container.textContent ?? '', /—/);
});

test('a stopped turn keeps its last rate and the cumulative usage', () => {
  const { container, rerender } = render(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 30 })} isGenerating />);
  rerender(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 30 })} isGenerating={false} />);

  assert.match(container.textContent ?? '', /last 30\.0 tok\/s/);
  assert.match(container.textContent ?? '', /1\.2K/, 'the cumulative token count is preserved');
});

test('clicking still opens the token breakdown', () => {
  const onClick = vi.fn();
  render(<TokenUsageSummary usage={usage({ outputTokensPerSecond: 12 })} isGenerating onClick={onClick} />);

  screen.getByRole('button', { name: /show token usage/i }).click();
  assert.equal(onClick.mock.calls.length, 1);
});
