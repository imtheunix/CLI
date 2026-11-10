import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

import '@/modules/i18n';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

const renderSummary = (usage: Record<string, unknown> | null, isProcessing = false, onClick = () => {}) => (
  render(<TokenUsageSummary usage={usage} isProcessing={isProcessing} onClick={onClick} />)
);

describe('composer token rate', () => {
  it('shows a measured rate as live while the turn generates', () => {
    const { getByTestId } = renderSummary({
      used: 1_234,
      rate: { outputTokensPerSecond: 42.4, outputTokens: 120, elapsedMs: 2_830, live: true },
    }, true);

    assert.equal(getByTestId('token-rate').textContent, '42.4 tok/s');
  });

  it('labels the rate as last after the turn completes', () => {
    const { getByTestId } = renderSummary({
      used: 1_234,
      rate: { outputTokensPerSecond: 42.4, outputTokens: 120, elapsedMs: 2_830, live: true },
    }, false);

    assert.equal(getByTestId('token-rate').textContent, 'last 42.4 tok/s');
  });

  it('labels a provider that only reports usage at completion as last', () => {
    const { getByTestId } = renderSummary({
      used: 1_234,
      rate: { outputTokensPerSecond: 18, outputTokens: 90, elapsedMs: 5_000, live: false },
    }, true);

    assert.equal(getByTestId('token-rate').textContent, 'last 18.0 tok/s');
  });

  it('shows an explicit em dash when the provider reports no rate', () => {
    const { getByTestId } = renderSummary({ used: 1_234 }, true);

    assert.equal(getByTestId('token-rate').textContent, '— tok/s');
  });

  it('keeps the cumulative token count and the click behavior', () => {
    const onClick = vi.fn();
    const { getByRole, getByText } = renderSummary({
      used: 1_234,
      rate: { outputTokensPerSecond: 42.4, outputTokens: 120, elapsedMs: 2_830, live: true },
    }, true, onClick);

    assert.ok(getByText('1.2K'));
    fireEvent.click(getByRole('button'));
    assert.equal(onClick.mock.calls.length, 1);
  });
});
